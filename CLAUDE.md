# QuickTrimmer — Claude 起動コンテキスト

> 中間カットを、ドラッグだけで。ブラウザだけで完結する動画トリミングツール。
> https://quicktrimmer.vercel.app(本番稼働中・2026-05-28 ローンチ)

このファイルは新しい Claude セッションが**最初に読むべき短いコンテキスト**。
深い情報は **Vault**(`~/Documents/claude-vault/Projects/QuickTrimmer/`)が Source of Truth。

---

## 🗂 Vault が真実、ここは入口

新しいセッションを始めたら、まずこれを読む順:

1. このファイル(CLAUDE.md)で全体像を掴む
2. Vault の `決定事項.md` で「蒸し返さない判断」を読む
3. Vault の `セッション/` 直近を読んで前回までの流れを把握
4. 必要に応じて `README.md` / `アーキテクチャ.md` / `ローンチチェックリスト.md` / `Codexレビュー計画.md`

```
~/Documents/claude-vault/Projects/QuickTrimmer/
├── README.md              # プロジェクト全体マップ(状態 / URL / 主要機能)
├── 決定事項.md             # 蒸し返さない判断のリスト ← 必読
├── アーキテクチャ.md       # 100%クライアントサイドの設計詳細
├── ローンチチェックリスト.md # Done / TODO
├── Codexレビュー計画.md     # 敵対的レビュー実行記録
└── セッション/YYYY-MM-DD.md # 各回の作業詳細
```

横断知見は Vault `Knowledge/` 配下:
- `Knowledge/Claudeの落とし穴と対処法.md` — 特に **落とし穴 #4(Codex クロスレビュー)** はこのプロジェクトの教訓

---

## 🚀 スタック

- Vite 5.x(dev サーバ・本番ビルド)
- `@ffmpeg/ffmpeg` 0.12.x + `@ffmpeg/core` 0.12.x **ESM**(動画処理)
- Web Audio API(波形 / 無音検出)
- Canvas 2D(波形 + 目盛り)
- vanilla JS(フレームワークなし)
- Vercel(本番ホスティング・COOP/COEP ヘッダ自動)

依存はこれだけ。フレームワーク・ビルドツール追加は基本反対。

---

## 🛠 開発コマンド

```bash
npm install
npm run dev       # http://localhost:5173 (COOP/COEP 込み)
npm run build     # dist/ に出力
npm run preview   # ビルド済みプレビュー(COOP/COEP も効く)
vercel --prod     # 本番デプロイ
```

`/codex:adversarial-review src/<file>` で別 AI に意地悪レビュー(Codex プラグイン経由)。

---

## 📁 ファイル構造

```
src/
├── main.js          # オーケストレーション / キーボード / UI イベント
├── timeline.js      # タイムライン描画 / ドラッグ / ズーム / 履歴 / overlap 正規化
├── exporter.js      # ffmpeg.wasm 統合 / stream-copy ↔ 再エンコード自動切替
├── silence.js       # 無音検出(async + 協調的チャンク)
├── storage.js       # localStorage + JSON プロジェクト保存
├── settings.js      # ユーザー設定の永続化
├── thumbnails.js    # フレームサムネ生成(未統合・将来用)
└── style.css        # スタイル全部

public/
├── ffmpeg/          # ffmpeg-core.js + ffmpeg-core.wasm(ESM 版、約 32MB)
├── icons/           # PWA アイコン SVG
├── manifest.webmanifest
└── sw.js            # Service Worker(オフラインキャッシュ)

vercel.json          # COOP/COEP ヘッダ、framework 設定
vite.config.js       # dev/preview に COOP/COEP、ffmpeg を optimizeDeps 除外
tools/og-snapshot.html # OGP 画像作成用テンプレ（正本。スクショ→public/og-image.png、デプロイされない）
```

---

## 🧱 蒸し返さない判断(抜粋)

詳細は Vault の `決定事項.md`。新セッションで「これ別のやり方どう?」と提案する前に**必ず一読**。

1. **ローカル処理完結が差別化の核** — サーバー側 ffmpeg 案は不採用。アップロード不要を売る
2. **ストリームコピーがデフォルト** — 倍速 / 形式変更 / 解像度変更 / 音量正規化 / 非 MP4 入力時のみ再エンコード
3. **stream copy 出力は常に `.mp4`** — 入力拡張子に依存しない。非 MP4 ファミリーは強制再エンコード分岐
4. **範囲オーバーラップは "new-wins"** — `placeRangeInto()` ヘルパーで異なる type/speed の既存範囲を切り取る
5. **外部入力は `validateExternalRange()` でサニタイズ** — `Number.isFinite` / クランプ / type whitelist / speed `[2, 4, 8]`
6. **`init-notify` は `{ initial: true }` で autosave 抑制** — 復元プロンプト前のクロバー防止
7. **無音検出は async + 協調的チャンク** — Web Worker は AudioBuffer transferable 問題で不採用
8. **マルチクリップ・Whisper.wasm フィラー検出は v0.2 繰越** — 工数大、現スコープ外
9. **広告投下はオーガニックデータ蓄積後** — まず X / Reddit / HN / PH の無料チャネル
10. **ライセンス = GPL-3.0-or-later**(同梱 ffmpeg-core が GPL ビルドのため)
11. **ターゲット = ゲームクリップ→X 投稿層**(汎用トリマーでなく一点集中。X用書き出し=実コーデックで判定し stream-copy 優先、HEVC/PS5 等のみ transcode、縦動画は無劣化維持)

---

## ⚠️ 高リスクファイル(修正時は Codex レビュー推奨)

| ファイル | リスクの種類 |
|---|---|
| `src/exporter.js` | FFmpeg フィルタ文字列ビルド、stream-copy ↔ 再エンコード切替、`atempo` 倍速チェーン |
| `src/timeline.js` | 座標math(ズーム連動)、overlap 正規化、履歴、外部入力サニタイズ |
| `src/silence.js` | 検出アルゴリズム、誤検出率は UX を直撃 |

修正後は必ず:
```
/codex:adversarial-review src/<修正したファイル>
```

返ってきた指摘は **「真のバグ / エッジケース / スタイル」で振り分け、真のバグだけ即修正**。
全部対応すると消耗する(`Knowledge/Claudeの落とし穴と対処法.md` 落とし穴 #4 参照)。

---

## 🎯 アクティブな次の一手(2026-06-03 時点)

> ターゲットを「**ゲームのクリップを X に上げたい層**」に確定。**X用書き出し(F1〜F4)実装・本番稼働**。告知素材(日英カード・デモ・OG・文面)も完成。詳細は Vault `セッション/2026-06-03.md`。

### 残り(ほぼ告知だけ)
- [ ] **告知投稿**(X / Reddit / Zenn / Show HN / PH。文面＝Vault `告知文ドラフト.md` ピボット版・日英、素材＝`Downloads/quicktrimmer-cards/`(JP/EN カード + demo.mp4/gif))
- [ ] 本人クリップで本番スモーク(自分の神プレイを実際に X に上げて体験)

### 完了済み(このターゲットの実装)
- X用書き出しボタン(コーデック自動判定→必要時のみ H.264 化 / 縦動画は無劣化 / 4K→1080p / 対 X 上限バッジ / faststart)。Codex 2 回レビュー反映、ヘッドレス＋実クリップ検証済み

### v0.2 ヘッドライン:AI 字幕生成(Whisper.wasm)
詳細プランは Vault の `v0.2-字幕生成プラン.md`

- スケジュール: Week 2 で MVP(SRT 書き出し)→ Week 3 で編集 UI + 焼き込み → Week 4 ローンチ
- 技術: `@xenova/transformers` で Whisper をブラウザ実行(lazy load、~140MB base モデル)
- 外部 API は不採用(「アップロード不要」のブランド違反)

### v0.2 同梱候補(余裕あれば)
- [ ] マルチクリップ対応(`clips: Clip[]` 状態リファクタ)
- [ ] Whisper を再利用したフィラー(「えーと」)検出
- [ ] サムネイルストリップ表示(`thumbnails.js` を統合)
- [ ] 設定の同期(ブラウザ間)
- [ ] 有料プラン(4K / 長尺 / AI 機能)

---

## 🚫 やらないこと(誘惑された時の参照)

- 動画ファイルをサーバーに送る → ローカル処理が核なのでサーバー側 ffmpeg は不採用
- フレームワーク導入(React / Vue)→ vanilla で軽量さを保つ
- 広告投下 → オーガニックデータが出てから
- マルチクリップ実装 → v0.2 までスコープ凍結
- 「動画編集者の知人に触ってもらう」テスト → 自分でテスト方針(本人決定)

---

## 🤝 Codex 連携

このプロジェクトは Claude + Codex のクロスレビュー体制。

- **Claude**: 機能実装・修正・統合
- **Codex**: 敵対的レビュー(`/codex:adversarial-review`)・難バグ救援(`/codex:rescue`)
- Windows 環境なので **Computer Use は使えない**(Mac 限定)

Codex プラグインは Claude Code に導入済(`openai/codex-plugin-cc`)。新セッションでは `/codex:setup` で接続確認。

---

## 🔗 関連プロジェクト

- **QuickThumb** — 同じく vanilla / Vercel / クライアントサイドの個人開発。サムネイル AI 生成。
  ローカル: `C:\Users\PC_User\projects\quickthumb-app\` / Vault: `~/Documents/claude-vault/Projects/QuickThumb/`

---

**最終更新**: 2026-06-03(ターゲット確定＋X用書き出し本番稼働)
