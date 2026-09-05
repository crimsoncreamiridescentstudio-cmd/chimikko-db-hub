import { firebaseConfig } from "./firebase-config.js";
import { IMAGE_KEYS, prepareImage, isWebP } from "./image-codec.js";
import { ReadCache, readWithDeadline } from './read-cache.js';

const $ = selector => document.querySelector(selector);
const form = $("#profile-form");
const editor = $("#editor-dialog");
const detail = $("#detail-dialog");
const consent = $("#consent-dialog");
const message = text => { $("#app-message").textContent = text; };
const editorMessage = text => { $("#editor-message").textContent = text; };
const make = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
let db, auth, F, A;
let user = null;
let savedProfile = null;
let pending = new Map();
let imageTasks = 0;
let saving = false;
let dirty = false;
let opening = false;
let editorEpoch = 0;
let gridEpoch = 0;
let detailEpoch = 0;
let detailUid = null;
let authEpoch = 0;
const publicProfiles = new ReadCache({ ttl: 30000, max: 6 });
const ownProfiles = new ReadCache({ ttl: 30000, max: 1 });
const memberships = new ReadCache({ ttl: 30000, max: 1 });
const imageCache = new ReadCache({ ttl: 120000, max: 48 });
let publicVersions = new Map();
const imageVersions = new Map();
const editorUrls = new Set();
const gridUrls = new Set();
const detailUrls = new Set();
const clearUrls = urls => { urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); };

function describe(error) {
  const code = error?.code || "";
  if (code === "permission-denied") {
    memberships.clear();
    ownProfiles.clear();
    return "アクセスできません。参加受付の設定・参加権限・Firestoreルールを確認してください。入力内容はこの画面に残っています。";
  }
  if (code === "resource-exhausted") return "無料枠などの利用上限に達しました。時間を置いて試してください。";
  if (code.includes("popup-blocked")) return "ログイン画面がブロックされました。Safari等の通常ブラウザで開き、ポップアップを許可してもう一度押してください。";
  if (code.includes("popup-closed") || code.includes("cancelled-popup")) return "ログインをキャンセルしました。";
  if (code.includes("unauthorized-domain")) return "このサイトのドメインがFirebase Authenticationの承認済みドメインに未登録です。";
  if (code === "unavailable" || code.includes("network")) return "通信できません。接続を確認して再度お試しください。入力内容はこの画面に残っています。";
  return error?.message || "処理できませんでした。もう一度お試しください。";
}

function emptyProfile() {
  return { name: "", bio: "", world: "", published: false,
    characters: Array.from({ length: 3 }, () => ({ name: "", description: "" })),
    images: Object.fromEntries(IMAGE_KEYS.map(key => [key, ""])) };
}

async function signIn() {
  consent.close();
  $("#login-button").disabled = true;
  try { await A.signInWithPopup(auth, new A.GoogleAuthProvider()); }
  catch (error) { message(describe(error)); }
  finally { $("#login-button").disabled = false; }
}

function requestSignIn() {
  const checkbox = $("#consent-checkbox");
  checkbox.checked = false;
  $("#consent-login").disabled = true;
  consent.showModal();
  checkbox.focus();
}

// 六つの固定席をトランザクションとサーバー側ルールで確保。
// 0は運営者専用、1〜5は先着。クライアントの人数表示には依存しない。
async function ensureMember(uid) {
  return memberships.get(uid, async () => {
    const memberRef = F.doc(db, 'members', uid);
    const existing = await readWithDeadline(F.getDocFromServer(memberRef));
    if (existing.exists()) {
      if (!existing.data().active) throw new Error('このアカウントの投稿受付は停止されています。');
      return true;
    }
    await F.runTransaction(db, async tx => {
    const memberRef = F.doc(db, "members", uid);
    const member = await tx.get(memberRef);
    if (member.exists()) {
      if (!member.data().active) throw new Error("このアカウントの投稿受付は停止されています。");
      return;
    }
    const settings = await tx.get(F.doc(db, "settings", "registration"));
    if (!settings.exists()) throw new Error("参加受付は準備中です。運営者による初期設定が必要です。");
    const config = settings.data();
    const admin = uid === config.adminUid;
    if (!admin && config.open !== true) throw new Error("現在、新規参加の受付は停止中です。");
    const candidates = admin ? ["0"] : ["1", "2", "3", "4", "5"];
    const refs = candidates.map(slot => F.doc(db, "seats", slot));
    const snapshots = await Promise.all(refs.map(ref => tx.get(ref)));
    const index = snapshots.findIndex(snap => !snap.exists());
    if (index < 0) throw new Error("参加枠が埋まりました。ログインなしで閲覧できます。");
    tx.set(memberRef, { slot: candidates[index], active: true, createdAt: F.serverTimestamp() });
    tx.set(refs[index], { uid, createdAt: F.serverTimestamp() });
    });
    return true;
  });
}

function readOwnProfile(uid) {
  return ownProfiles.get(uid, async () => {
    const snapshot = await readWithDeadline(F.getDocFromServer(F.doc(db, 'profiles', uid)));
    return snapshot.exists() ? snapshot.data() : null;
  });
}

function imageControl(key, title) {
  const area = make("section", undefined, "image-editor");
  const label = make("label", title);
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp";
  label.append(input);
  const preview = make("img", undefined, "image-preview");
  preview.alt = `${title}のプレビュー`;
  preview.hidden = true;
  preview.dataset.preview = key;
  const status = make("p", "未設定", "image-message help");
  const remove = make("button", "画像を外す", "button button-small");
  remove.type = "button";
  remove.addEventListener("click", () => {
    imageVersions.set(key, (imageVersions.get(key) || 0) + 1);
    pending.set(key, null);
    preview.hidden = true;
    preview.removeAttribute("src");
    input.value = "";
    status.textContent = "保存すると画像を削除します。";
    dirty = true;
  });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    const version = (imageVersions.get(key) || 0) + 1;
    imageVersions.set(key, version);
    const epoch = editorEpoch;
    imageTasks++;
    form.querySelector("[type=submit]").disabled = true;
    status.textContent = "画像を縮小しています…";
    try {
      const prepared = await prepareImage(file, { onProgress: text => {
        if (epoch === editorEpoch && imageVersions.get(key) === version) status.textContent = text;
      } });
      if (epoch !== editorEpoch || imageVersions.get(key) !== version) return;
      pending.set(key, prepared);
      const url = URL.createObjectURL(new Blob([prepared.full.bytes], { type: "image/webp" }));
      editorUrls.add(url);
      preview.src = url;
      preview.hidden = false;
      status.textContent = `${prepared.full.width} × ${prepared.full.height}px・${Math.ceil(prepared.full.bytes.length / 1000)}KB。保存ボタンで反映します。${prepared.thumb ? "" : " この環境では一覧用画像を作れないため、詳細画面だけに表示します。"}`;
      dirty = true;
    } catch (error) {
      if (epoch === editorEpoch && imageVersions.get(key) === version) status.textContent = describe(error);
    } finally {
      imageTasks--;
      form.querySelector("[type=submit]").disabled = imageTasks > 0 || saving;
      input.value = "";
    }
  });
  area.append(label, preview, status, remove);
  if (savedProfile?.images[key]) {
    const epoch = editorEpoch;
    status.textContent = "保存済みの画像があります。変更しなければそのまま残ります。";
    loadImage(user.uid, key, false, preview, editorUrls, () => epoch === editorEpoch && !pending.has(key), savedProfile.images[key])
      .catch(() => { if (epoch === editorEpoch) status.textContent = "保存済み画像を取得できませんでした。変更しなければ元の画像は残ります。"; });
  }
  return area;
}

async function openEditor() {
  if (!user) { requestSignIn(); return; }
  if (opening) return;
  opening = true;
  const uid = user.uid;
  const session = authEpoch;
  message("参加枠と保存内容を確認しています…");
  const slow = setTimeout(() => {
    if (session === authEpoch) message('通信の応答を待っています。初回は参加枠も確保します。再読み込みせず、もう少しお待ちください。');
  }, 5000);
  try {
    const [, profileData] = await Promise.all([ensureMember(uid), readOwnProfile(uid)]);
    if (user?.uid !== uid || session !== authEpoch) return;
    editorEpoch++;
    clearUrls(editorUrls);
    pending = new Map();
    imageVersions.clear();
    savedProfile = profileData;
    const data = savedProfile || emptyProfile();
    for (const key of ["name", "bio", "world"]) form.elements.namedItem(key).value = data[key];
    form.elements.namedItem("published").checked = data.published;
    $("#avatar-editor").replaceChildren(imageControl("avatar", "プロフィール画像（任意）"));
    const characters = $("#character-editors");
    characters.replaceChildren();
    data.characters.forEach((character, index) => {
      const section = make("section", undefined, "character-editor");
      section.append(make("h3", `代表キャラクター ${index + 1}`));
      const nameLabel = make("label", "名前（40文字まで）");
      const input = document.createElement("input");
      input.name = `char${index + 1}Name`;
      input.maxLength = 40;
      input.value = character.name;
      nameLabel.append(input);
      const descLabel = make("label", "紹介（300文字まで）");
      const textarea = document.createElement("textarea");
      textarea.name = `char${index + 1}Description`;
      textarea.maxLength = 300;
      textarea.rows = 3;
      textarea.value = character.description;
      descLabel.append(textarea);
      section.append(nameLabel, descLabel, imageControl(`char${index + 1}`, "立ち絵（任意）"));
      characters.append(section);
    });
    $("#delete-profile").hidden = !savedProfile;
    dirty = false;
    editorMessage("未保存の内容は、この画面を閉じたり再読み込みしたりすると失われます。");
    editor.showModal();
    message("ログイン中です。自分のプロフィールを編集できます。");
  } catch (error) { message(describe(error)); }
  finally { clearTimeout(slow); opening = false; }
}

async function saveProfile(event) {
  event.preventDefault();
  if (!user || saving || imageTasks) return;
  const name = form.elements.namedItem("name").value.trim();
  if (!name) { editorMessage("公開用の名前を入力してください。"); return; }
  saving = true;
  $("#editor-fields").disabled = true;
  editorMessage("保存しています…通信中はこの画面を閉じないでください。");
  const uid = user.uid;
  try {
    const profileRef = F.doc(db, "profiles", uid);
    const batch = F.writeBatch(db);
    const images = { ...(savedProfile?.images || emptyProfile().images) };
    for (const [key, prepared] of pending) {
      const fullRef = F.doc(profileRef, "images", key);
      const thumbRef = F.doc(profileRef, "images", `${key}-thumb`);
      if (prepared) {
        const payload = image => ({ data: F.Bytes.fromUint8Array(image.bytes), width: image.width, height: image.height,
          mime: "image/webp", revision: prepared.revision, updatedAt: F.serverTimestamp() });
        batch.set(fullRef, payload(prepared.full));
        if (prepared.thumb) batch.set(thumbRef, payload(prepared.thumb));
        else batch.delete(thumbRef);
        images[key] = prepared.revision;
      } else {
        batch.delete(fullRef);
        batch.delete(thumbRef);
        images[key] = "";
      }
    }
    const data = { name, bio: form.elements.namedItem("bio").value,
      world: form.elements.namedItem("world").value,
      published: form.elements.namedItem("published").checked,
      characters: [1, 2, 3].map(index => ({ name: form.elements.namedItem(`char${index}Name`).value.trim(),
        description: form.elements.namedItem(`char${index}Description`).value })),
      images, updatedAt: F.serverTimestamp() };
    batch.set(profileRef, data);
    await batch.commit();
    ownProfiles.set(uid, data);
    imageCache.drop(`${uid}:`);
    if (data.published) publicProfiles.set(uid, data);
    else publicProfiles.drop(uid);
    savedProfile = data;
    pending.clear();
    dirty = false;
    $("#delete-profile").hidden = false;
    editorMessage(data.published ? "保存しました！ほかの人もプロフィールと立ち絵を閲覧できます。" : "非公開で保存しました。本人だけが閲覧できます。");
  } catch (error) { editorMessage(describe(error)); }
  finally { saving = false; $("#editor-fields").disabled = false; }
}

async function deleteProfile() {
  if (!user || saving || imageTasks || !confirm("プロフィール・キャラ・全画像を削除します。元に戻せません。参加枠とログインアカウントは残ります。削除しますか？")) return;
  saving = true;
  $("#editor-fields").disabled = true;
  editorMessage("投稿データを削除しています…");
  try {
    const ref = F.doc(db, "profiles", user.uid);
    const batch = F.writeBatch(db);
    for (const key of IMAGE_KEYS) {
      batch.delete(F.doc(ref, "images", key));
      batch.delete(F.doc(ref, "images", `${key}-thumb`));
    }
    batch.delete(ref);
    await batch.commit();
    ownProfiles.clear();
    publicProfiles.drop(user.uid);
    imageCache.drop(`${user.uid}:`);
    dirty = false;
    editor.close();
    message("投稿データを削除しました。参加枠とログインアカウントは残っています。");
  } catch (error) { editorMessage(describe(error)); }
  finally { saving = false; $("#editor-fields").disabled = false; }
}

async function loadImage(uid, key, thumbnail, target, urls, current, revision) {
  const cacheKey = `${uid}:${key}:${thumbnail ? 'thumb' : 'full'}:${revision}`;
  const bytes = await imageCache.get(cacheKey, async () => {
    const snapshot = await readWithDeadline(F.getDocFromServer(F.doc(db, "profiles", uid, "images", thumbnail ? `${key}-thumb` : key)));
    if (!snapshot.exists()) return null;
    const data = snapshot.data();
    // Never show a different revision under an old cached profile.
    if (data.revision !== revision) throw new Error('画像が更新されました。プロフィールを開き直してください。');
    const bytes = data.data.toUint8Array();
    if (data.mime !== "image/webp" || !isWebP(bytes) || bytes.length > (thumbnail ? 20000 : 150000)) throw new Error("無効な画像です。");
    return bytes;
  });
  if (!current() || !bytes) return;
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
  urls.add(url);
  target.src = url;
  target.hidden = false;
}

function renderProfiles(snapshot) {
  // Only server-confirmed snapshots may refresh reusable public data.
  if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
  const versions = new Map(snapshot.docs.map(record => [record.id, JSON.stringify(record.data())]));
  for (const [uid, previous] of publicVersions) {
    if (versions.get(uid) !== previous) {
      publicProfiles.drop(uid);
      const next = versions.get(uid);
      if (!next || JSON.stringify(JSON.parse(previous).images) !== JSON.stringify(JSON.parse(next).images)) imageCache.drop(`${uid}:`);
      if (user?.uid === uid) ownProfiles.clear();
      if (detailUid === uid) {
        detailEpoch++;
        clearUrls(detailUrls);
        $('#detail-content').replaceChildren(make('p', '公開状態または内容が変わりました。閉じてから開き直してください。'));
      }
    }
  }
  publicVersions = versions;
  snapshot.forEach(record => publicProfiles.set(record.id, record.data()));
  const epoch = ++gridEpoch;
  clearUrls(gridUrls);
  const grid = $("#profile-grid");
  grid.replaceChildren();
  $("#list-label").textContent = `公開中 ${snapshot.size}件 ／ 参加枠は全6枠`;
  if (snapshot.empty) grid.append(make("p", "まだ公開プロフィールはありません。最初の小さな世界を置いてみませんか。"));
  snapshot.forEach(record => {
    const data = record.data();
    const card = make("article", undefined, "profile-card");
    const frame = make("div", undefined, "profile-image");
    const image = document.createElement("img");
    image.alt = `${data.name}のプロフィールまたは代表キャラクター画像`;
    image.hidden = true;
    image.loading = "lazy";
    const fallback = make("span", "画像は「見る」で確認");
    image.onload = () => { fallback.hidden = true; };
    frame.append(fallback, image);
    const thumbnailKey = IMAGE_KEYS.find(key => data.images[key]);
    if (thumbnailKey) loadImage(record.id, thumbnailKey, true, image, gridUrls, () => epoch === gridEpoch, data.images[thumbnailKey]).catch(() => {});
    const content = make("div", undefined, "profile-content");
    const view = make("button", "見る", "button button-small");
    view.type = "button";
    view.addEventListener("click", () => showDetail(record.id));
    content.append(make("h3", data.name, "profile-name user-text"), make("p", data.bio, "profile-text user-text"), view);
    card.append(frame, content);
    grid.append(card);
  });
}

async function showDetail(uid) {
  const epoch = ++detailEpoch;
  detailUid = uid;
  clearUrls(detailUrls);
  const content = $("#detail-content");
  content.replaceChildren(make("p", "プロフィールを読み込んでいます…"));
  if (!detail.open) detail.showModal();
  try {
    let data = publicProfiles.peek(uid);
    if (!data) {
      const snapshot = await readWithDeadline(F.getDocFromServer(F.doc(db, 'profiles', uid)));
      if (epoch !== detailEpoch) return;
      if (!snapshot.exists()) throw new Error('このプロフィールは見つかりませんでした。');
      data = snapshot.data();
      if (data.published) publicProfiles.set(uid, data);
    }
    const title = make("h2", data.name, "user-text");
    title.id = "detail-title";
    content.replaceChildren(title);
    const addImage = key => {
      if (!data.images[key]) return;
      const img = make("img", undefined, "full-image");
      img.alt = key === "avatar" ? `${data.name}の画像` : `${data.characters[Number(key.slice(-1)) - 1].name || "キャラクター"}の立ち絵`;
      img.hidden = true;
      const status = make("p", "画像を読み込んでいます…", "help");
      content.append(img, status);
      img.onload = () => status.remove();
      img.onerror = () => { status.textContent = "この画像を表示できませんでした。"; };
      loadImage(uid, key, false, img, detailUrls, () => epoch === detailEpoch, data.images[key])
        .then(() => { if (epoch === detailEpoch && !img.src) status.textContent = "画像は未設定、または削除済みです。"; })
        .catch(() => { if (epoch === detailEpoch) status.textContent = "画像を取得できませんでした。閉じてからもう一度お試しください。"; });
    };
    addImage("avatar");
    content.append(make("p", data.bio, "user-text"));
    if (data.world) content.append(make("h3", "世界観メモ"), make("p", data.world, "user-text"));
    data.characters.forEach((character, index) => {
      if (!character.name && !character.description && !data.images[`char${index + 1}`]) return;
      content.append(make("h3", character.name || `キャラクター ${index + 1}`, "user-text"));
      addImage(`char${index + 1}`);
      content.append(make("p", character.description, "user-text"));
    });
    if (data.published) {
      const label = make("label", "共有リンク");
      const link = document.createElement("input");
      const url = new URL(location.href);
      url.search = "";
      url.hash = "";
      url.searchParams.set("profile", uid);
      link.value = url.href;
      link.readOnly = true;
      link.addEventListener("click", () => link.select());
      label.append(link);
      content.append(label);
    }
  } catch (error) {
    if (epoch === detailEpoch) content.replaceChildren(make("p", "プロフィールを表示できません。非公開・削除済み、または通信エラーの可能性があります。"));
  }
}

form.addEventListener("submit", saveProfile);
form.addEventListener("input", () => { dirty = true; });
$("#delete-profile").addEventListener("click", deleteProfile);
function mayClose() {
  if (saving || imageTasks) { editorMessage("画像の処理・保存が終わってから閉じてください。"); return false; }
  return !dirty || confirm("まだ保存していない変更を破棄して閉じますか？");
}
$("#editor-close").addEventListener("click", () => { if (mayClose()) editor.close(); });
editor.addEventListener("cancel", event => { if (!mayClose()) event.preventDefault(); });
editor.addEventListener("close", () => { editorEpoch++; clearUrls(editorUrls); pending.clear(); dirty = false; });
$("#detail-close").addEventListener("click", () => detail.close());
detail.addEventListener("close", () => { detailUid = null; detailEpoch++; clearUrls(detailUrls); $("#detail-content").replaceChildren(); });
window.addEventListener("beforeunload", event => {
  if (dirty || saving || imageTasks) { event.preventDefault(); event.returnValue = ""; }
});

async function boot() {
  if (!["apiKey", "authDomain", "projectId", "appId"].every(key => typeof firebaseConfig[key] === "string" && firebaseConfig[key].trim())) {
    message("接続準備中です。以下はデモ表示で、まだログイン・投稿はできません。");
    return;
  }
  $("#profile-grid").replaceChildren(make("p", "公開プロフィールを読み込んでいます…"));
  $("#list-label").textContent = "接続中";
  try {
    const [core, authentication, firestore] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js"),
      import("https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js")
    ]);
    A = authentication;
    F = firestore;
    const app = core.initializeApp(firebaseConfig);
    auth = A.getAuth(app);
    db = F.initializeFirestore(app, { experimentalAutoDetectLongPolling: true,
      experimentalLongPollingOptions: { timeoutSeconds: 5 } });
    // ディスクへの永続キャッシュは有効化しない。端末共有時の残存を減らす。
    $("#login-button").addEventListener("click", requestSignIn);
    $("#consent-checkbox").addEventListener("change", event => {
      $("#consent-login").disabled = !event.currentTarget.checked;
    });
    $("#consent-login").addEventListener("click", signIn);
    $("#consent-cancel").addEventListener("click", () => consent.close());
    $("#join-button").addEventListener("click", openEditor);
    $("#edit-button").addEventListener("click", openEditor);
    $("#logout-button").addEventListener("click", async () => {
      if (saving || imageTasks || opening) return;
      if (editor.open && !mayClose()) return;
      try { await A.signOut(auth); } catch (error) { message(describe(error)); }
    });
    let stopProfiles;
    const watchProfiles = () => {
      stopProfiles?.();
      stopProfiles = F.onSnapshot(F.query(F.collection(db, 'profiles'), F.where('published', '==', true), F.limit(6)),
        { includeMetadataChanges: true }, renderProfiles, error => {
          publicProfiles.clear(); imageCache.clear(); publicVersions.clear();
          detail.close();
          gridEpoch++;
          clearUrls(gridUrls);
          $('#profile-grid').replaceChildren(make('p', 'プロフィールを読み込めませんでした。設定・通信を確認してページを再読み込みしてください。'));
          $('#list-label').textContent = '取得できませんでした';
          message(describe(error));
        });
    };
    A.onAuthStateChanged(auth, current => {
      authEpoch++;
      memberships.clear(); ownProfiles.clear(); publicProfiles.clear(); imageCache.clear();
      publicVersions.clear();
      gridEpoch++;
      clearUrls(gridUrls);
      user = current;
      editor.close();
      detail.close();
      savedProfile = null;
      $("#login-button").hidden = !!current;
      $("#login-button").disabled = false;
      $("#join-button").disabled = false;
      $("#edit-button").hidden = !current;
      $("#logout-button").hidden = !current;
      message(current ? "ログインしました。「自分のプロフィール」から参加・編集できます。" : "閲覧はログイン不要です。投稿する方はGoogleでログインしてください。");
      // Read only: signing in alone must never claim a participant seat.
      if (current) readOwnProfile(current.uid).catch(() => {});
      watchProfiles();
    });
    const shared = new URL(location.href).searchParams.get("profile");
    if (shared && /^[A-Za-z0-9_-]{1,128}$/.test(shared)) {
      await auth.authStateReady();
      await showDetail(shared);
    }
  } catch (error) { message(`接続できませんでした。${describe(error)}`); }
}
boot();
