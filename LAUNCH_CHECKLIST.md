# Launch Checklist

ローンチまでにやるべきことのチェックリスト。Claude が触れる範囲は ✓ 済み、Codex に任せる範囲は別途 [CODEX_REVIEW.md](./CODEX_REVIEW.md) 参照。

## ✅ Done (Claude)

### Infrastructure
- [x] Vite ビルドが通る (`npm run build`)
- [x] `vercel.json` で COOP/COEP ヘッダ設定済み
- [x] `/public/` の静的ファイル（ffmpeg-core, sw.js, icons, manifest）が dist/ に正しくコピーされる
- [x] Service worker でオフラインキャッシュ
- [x] PWA manifest with icons

### SEO / Social
- [x] `<meta name="description">`
- [x] Open Graph タグ（og:title, og:description, og:image, og:locale）
- [x] Twitter card
- [x] Favicon (SVG) + apple-touch-icon

### Documentation
- [x] README.md
- [x] LAUNCH_CHECKLIST.md (このファイル)
- [x] CODEX_REVIEW.md (Codex に投げるレビューポイント)

### Quality (basic)
- [x] JSON ロード時のスキーマ検証（XSSリスク低減）
- [x] エラーメッセージに FFmpeg ログ末尾を含めて表示
- [x] 書き出しキャンセル機能

## ⏳ Codex に投げる (別ファイル参照)

→ **[CODEX_REVIEW.md](./CODEX_REVIEW.md)** を見ながら `/codex:adversarial-review` を実行

## ⏳ 人間が決めること

### コンテンツ / ブランディング
- [ ] 公開ドメイン名を決める（`quicktrimmer.app` / `.dev` などを取得確認）
- [ ] OGP 用の本物の画像（PNG 1200x630）を作成 — 現状は SVG アイコンを流用
- [ ] サポート問い合わせ先（メール or Twitter）
- [ ] プライバシーポリシー / 利用規約（ローカル処理だから最小限でOK、でも一応必要）
- [ ] ライセンス決定（MIT? GPL? AGPL? ffmpeg は GPL なので注意）

### 配信
- [ ] Vercel プロジェクト作成 + ドメイン紐付け
- [ ] Vercel Analytics or Plausible でアクセス計測（任意）
- [ ] (任意) Sentry でエラー収集
- [ ] (任意) RUM (Web Vitals) ログ

### 検証
- [ ] Chrome / Edge / Firefox / Safari で動作確認
- [ ] 大きな動画（500MB / 1GB / 4K）で書き出しテスト
- [ ] モバイルブラウザでの体験チェック
- [ ] **動画編集者の知人に15分触らせてフィードバック取る**（一番効く検証）

### マーケティング
- [ ] ローンチ告知（Twitter / Product Hunt / Indie Hackers / reddit r/sideproject）
- [ ] スクリーンキャプチャ動画（30秒）— 自分のツールでカットすると最高
- [ ] 「再エンコードなし高速書き出し」「アップロード不要」を前面に出す

## デプロイコマンド一覧

```bash
# プレビュー（ビルド済みファイルをローカル確認）
npm run build && npm run preview

# Vercel preview デプロイ
vercel

# Vercel 本番デプロイ
vercel --prod
```

## ローンチ後

- [ ] ユーザーからのフィードバック収集チャンネル
- [ ] バグ報告の受け口
- [ ] 機能リクエストのトリアージ
- [ ] マルチクリップ対応（次バージョン）
- [ ] Whisper.wasm によるフィラー検出（次バージョン）
