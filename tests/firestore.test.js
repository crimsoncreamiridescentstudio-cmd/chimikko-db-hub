import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, writeBatch, runTransaction, Bytes, serverTimestamp } from 'firebase/firestore';

let env;
const admin = 'test-admin';
const claims = { email_verified: true, firebase: { sign_in_provider: 'google.com' } };
const userDb = uid => env.authenticatedContext(uid, claims).firestore();
const anonymousDb = () => env.unauthenticatedContext().firestore();
const profile = (published = true) => ({ name: 'テスト', bio: '', world: '', published,
  characters: [0, 1, 2].map(() => ({ name: '', description: '' })),
  images: { avatar: '', char1: '', char2: '', char3: '' }, updatedAt: serverTimestamp() });
const image = (size = 100) => ({ data: Bytes.fromUint8Array(new Uint8Array(size)), width: 100, height: 100,
  mime: 'image/webp', revision: '12345678-1234-1234-1234-123456789012', updatedAt: serverTimestamp() });

async function join(uid, slot, db = userDb(uid)) {
  const batch = writeBatch(db);
  batch.set(doc(db, 'members', uid), { slot, active: true, createdAt: serverTimestamp() });
  batch.set(doc(db, 'seats', slot), { uid, createdAt: serverTimestamp() });
  return batch.commit();
}
async function seedSettings(open = true) {
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'settings', 'registration'), { adminUid: admin, open });
  });
}

before(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Emulator required; never connect to production.');
  env = await initializeTestEnvironment({ projectId: 'demo-chimikko-test', firestore: { rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8') } });
});
beforeEach(async () => { await env.clearFirestore(); await seedSettings(); });
after(async () => { await env?.cleanup(); });

test('six fixed seats, admin reservation, no seventh, no multi-seat membership', async () => {
  await assertFails(join('outsider', '0'));
  await assertSucceeds(join(admin, '0'));
  for (let i = 1; i <= 5; i++) await assertSucceeds(join(`member${i}`, String(i)));
  await assertFails(join('seventh', '6'));
  await assertFails(join('seventh', '5'));
  await assertFails(join('member1', '2'));
  await assertFails(setDoc(doc(userDb('outsider'), 'members', 'outsider'), { slot: '1', active: true, createdAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(userDb('member1'), 'seats', '1')));
});

test('closed registration permits admin only; unsigned and unverified users denied', async () => {
  await seedSettings(false);
  await assertFails(join('member1', '1'));
  await assertSucceeds(join(admin, '0'));
  await seedSettings();
  await assertFails(join('anon', '1', anonymousDb()));
  const unverified = env.authenticatedContext('unverified', { ...claims, email_verified: false }).firestore();
  await assertFails(join('unverified', '1', unverified));
  await assertFails(updateDoc(doc(userDb('outsider'), 'settings', 'registration'), { open: true, adminUid: 'outsider' }));
});

test('owner can get absent profile, save profile and full/thumbnail images atomically', async () => {
  const db = userDb('member1');
  await join('member1', '1', db);
  await assertSucceeds(getDoc(doc(db, 'profiles', 'member1')));
  const batch = writeBatch(db);
  batch.set(doc(db, 'profiles', 'member1'), profile());
  for (const key of ['avatar', 'char1', 'char2', 'char3']) {
    batch.set(doc(db, 'profiles', 'member1', 'images', key), image(150000));
    batch.set(doc(db, 'profiles', 'member1', 'images', `${key}-thumb`), image(20000));
  }
  await assertSucceeds(batch.commit());
  await assertSucceeds(getDoc(doc(anonymousDb(), 'profiles', 'member1', 'images', 'char1')));
  await assertSucceeds(getDocs(query(collection(anonymousDb(), 'profiles'), where('published', '==', true))));
});

test('ownership, draft privacy, strict schema, capacities and image field types', async () => {
  const db = userDb('member1');
  await join('member1', '1', db);
  await setDoc(doc(db, 'profiles', 'member1'), profile(false));
  await setDoc(doc(db, 'profiles', 'member1', 'images', 'char1'), image());
  await assertFails(getDoc(doc(anonymousDb(), 'profiles', 'member1')));
  await assertFails(getDoc(doc(anonymousDb(), 'profiles', 'member1', 'images', 'char1')));
  await assertFails(getDoc(doc(userDb('other'), 'profiles', 'member1', 'images', 'char1')));
  await assertFails(setDoc(doc(userDb('other'), 'profiles', 'member1'), profile()));
  await assertFails(setDoc(doc(userDb('other'), 'profiles', 'other'), profile()));
  await assertFails(setDoc(doc(db, 'profiles', 'member1'), { ...profile(), email: 'not-public@example.test' }));
  await assertFails(setDoc(doc(db, 'profiles', 'member1'), { ...profile(), world: 'あ'.repeat(801) }));
  await assertFails(setDoc(doc(db, 'profiles', 'member1', 'images', 'char4'), image()));
  await assertFails(setDoc(doc(db, 'profiles', 'member1', 'images', 'char1'), image(150001)));
  await assertFails(setDoc(doc(db, 'profiles', 'member1', 'images', 'char1-thumb'), image(20001)));
  await assertFails(setDoc(doc(db, 'profiles', 'member1', 'images', 'char1'), { ...image(), data: 'not bytes' }));
  await assertFails(setDoc(doc(db, 'profiles', 'member1', 'images', 'char1'), { ...image(), width: 1001 }));
  await assertFails(setDoc(doc(db, 'profiles', 'member1', 'images', 'char1'), { ...image(), mime: 'image/svg+xml' }));
  await assertFails(getDocs(collection(anonymousDb(), 'profiles')));
});

test('unpublishing revokes new anonymous reads; deletion removes all known image docs', async () => {
  const db = userDb('member1');
  await join('member1', '1', db);
  await setDoc(doc(db, 'profiles', 'member1'), profile());
  await setDoc(doc(db, 'profiles', 'member1', 'images', 'char1'), image());
  await updateDoc(doc(db, 'profiles', 'member1'), { published: false, updatedAt: serverTimestamp() });
  await assertFails(getDoc(doc(anonymousDb(), 'profiles', 'member1', 'images', 'char1')));
  const batch = writeBatch(db);
  for (const key of ['avatar', 'char1', 'char2', 'char3']) {
    batch.delete(doc(db, 'profiles', 'member1', 'images', key));
    batch.delete(doc(db, 'profiles', 'member1', 'images', `${key}-thumb`));
  }
  batch.delete(doc(db, 'profiles', 'member1'));
  await assertSucceeds(batch.commit());
  await assertFails(setDoc(doc(db, 'profiles', 'member1', 'images', 'char1'), image()));
  await env.withSecurityRulesDisabled(async ctx => {
    assert.equal((await getDocs(collection(ctx.firestore(), 'profiles', 'member1', 'images'))).size, 0);
  });
});

test('concurrent first-come claims never allocate a seat twice', async () => {
  const attempt = uid => {
    const db = userDb(uid);
    return runTransaction(db, async tx => {
      const ref = doc(db, 'seats', '1');
      if ((await tx.get(ref)).exists()) throw new Error('Full');
      tx.set(ref, { uid, createdAt: serverTimestamp() });
      tx.set(doc(db, 'members', uid), { slot: '1', active: true, createdAt: serverTimestamp() });
    });
  };
  const results = await Promise.allSettled([attempt('racer1'), attempt('racer2')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
});

test('suspended member cannot write, but may remove own content', async () => {
  const db = userDb('member1');
  await join('member1', '1', db);
  await setDoc(doc(db, 'profiles', 'member1'), profile());
  await env.withSecurityRulesDisabled(async ctx => { await updateDoc(doc(ctx.firestore(), 'members', 'member1'), { active: false }); });
  await assertFails(setDoc(doc(db, 'profiles', 'member1'), profile()));
  await assertFails(setDoc(doc(db, 'profiles', 'member1', 'images', 'char1'), image()));
  await assertSucceeds(deleteDoc(doc(db, 'profiles', 'member1')));
});
