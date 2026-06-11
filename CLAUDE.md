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
├── subtitles.js     # ブラウザ内 Whisper 字幕生成(実装済み・本番はソフトゲートで非公開)
├── thumbnails.js    # フレームサムネ生成(未統合・将来用)
└── style.css        # スタイル全部

public/
├── ffmpeg/          # ffmpeg-core.js + ffmpeg-core.wasm(ESM 版、約 32MB)
├── ort/             # ONNX Runtime wasm(字幕用、同一オリジン配信。COEP 対策)
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
8. **Whisper.wasm フィラー検出は凍結** — 字幕機能ごと当面凍結(下記 12)。マルチクリップは 2026-06-11 に本人要望で解凍・出荷済み
9. **広告投下はオーガニックデータ蓄積後** — まず X / Reddit / HN / PH の無料チャネル
10. **ライセンス = GPL-3.0-or-later**(同梱 ffmpeg-core が GPL ビルドのため)
11. **ターゲット = ゲームクリップ→X 投稿層**(汎用トリマーでなく一点集中。X用書き出し=実コーデックで判定し stream-copy 優先、HEVC/PS5 等のみ transcode、縦動画は無劣化維持)
12. **AI 字幕(Whisper)は当面ローンチしない** — 実装済みだが本番はソフトゲートで非公開(`#subtitlePanel` の `hidden` 属性のみ。外せば即復活)。コア(クリップ→カット→X)集中が本人方針(2026-06-06)
13. **収益化は当面しない** — 将来はユーザーが増えたら寄付/スポンサー(ko-fi / GitHub Sponsors)を 1 個足すだけ。**機能ゲート・有料プランは不採用**(ローカル完結=限界費用ゼロ＋GPL でロック強制力なし。2026-06-03 決定)

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

## 🎯 アクティブな方針(2026-06-12 時点)

> **コア(ゲームクリップ→中間カット→X 投稿のループ)に改善を重ね、オーガニックに新規を増やす**(本人決定 2026-06-06)。
> 字幕・収益化は当面やらない。詳細は Vault `決定事項.md` と `セッション/` 直近。

### 出荷済みの主要機能(全部本番稼働中)
- 中間カット&倍速のドラッグ UX + 波形 + 無音検出
- X 用書き出し(実コーデック判定 → stream-copy 優先 / 必要時のみ H.264 化 / 1:1・9:16 レターボックス / 対 X 上限バッジ / faststart)
- 動画下の操作バー(再生・スキップ・カット開始/終了・ショートカットキーキャップ表示)+ 波形バー↔一覧の対応づけ
- **マルチクリップ結合「ハイライト」**(2026-06-11): 複数クリップを各々カット/倍速 → 1 本の X 用 MP4 に連結(MPEG-TS 中間 + concat。`timeline.js` 無改造、単一クリップ動作は不変)
- AI 字幕(Whisper、SRT/VTT)— 実装済みだが**ソフトゲートで非公開**

### 残り(コードは出荷済み、あとは本人の作業)
- [ ] **告知投稿の続き**(Reddit / Show HN / PH / Zenn。X は 6/6 に再告知済み。文面＝Vault `ローンチ実行プレイブック.md` + `ローンチ_スマホ貼り付け用.md`)
- [ ] 実ユーザーのフィードバック収集

### 次の機能の決め方
「コア改善ロードマップ」を多視点で ideate → 優先度付けして本人に提示 → 本人が選ぶ、の運用。

---

## 🚫 やらないこと(誘惑された時の参照)

- 動画ファイルをサーバーに送る → ローカル処理が核なのでサーバー側 ffmpeg は不採用
- フレームワーク導入(React / Vue)→ vanilla で軽量さを保つ
- 広告投下 → オーガニックデータが出てから
- AI 字幕の正式ローンチ → 当面凍結(ソフトゲートのまま。コア集中が本人方針)
- 機能ゲート・有料プラン → 不採用(将来も寄付/スポンサー型のみ)
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

**最終更新**: 2026-06-12(マルチクリップ出荷済み・字幕/収益化の凍結方針を反映)
