# chimikko-db-hub
A tiny character database and publishing hub for creators

## とりあえず…
先着5名さままでにしときます٩( ᐛ )و
デプロイ(公開)にはNetlifyを使ってるよ☺️

## 小型WebP投稿版

実装上の参加枠は運営1名＋参加者5名の合計6名です。Googleログイン、プロフィール・代表キャラ3名・世界観メモ、最大4枚の小型WebP投稿、公開／非公開、投稿削除に対応しています。

接続前はデモ表示のままです。[接続・運用手順](SETUP.md)に従ってFirebaseのWeb設定、Firestore Rules、インデックス除外、運営者の参加枠を設定してください。Cloud Storage・Blazeは使いません。

Netlifyは `npm run build` で静的ファイルだけを `dist` へコピーし公開します。テストツールやFirestoreルールを公開ディレクトリに含めません。

検証：`npm test`（画像処理）、`npm run test:rules`（Firestoreエミュレーター）。本番Firebaseと実ブラウザでのログイン・画像表示の確認は別途必要です。
