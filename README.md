# QuickTrimmer

中間カットを、ドラッグだけで。ブラウザだけで完結する動画トリミングツール。

[![PWA](https://img.shields.io/badge/PWA-ready-success)](#) [![No-Upload](https://img.shields.io/badge/upload-not%20required-brightgreen)](#) [![ffmpeg.wasm](https://img.shields.io/badge/ffmpeg-wasm-blue)](#)

## なぜ作ったか

既存の動画トリミングツールはほぼ「最初と最後をクロップ」しかできません。中間部分をカットするには「分割 → 範囲を選んで削除」という3ステップが必要で、しかも CapCut や Clipchamp は重い。

**QuickTrimmer は、タイムラインを左ドラッグするだけで中間カット**できます。アップロード不要、ローカル処理、再エンコードなしの高速書き出し。

## 主な機能

- ✂ **ドラッグだけで中間カット** — 左ドラッグ＝削除範囲追加、右ドラッグ＝取り消し
- 🔇 **無音区間の自動検出** — しきい値・最小持続時間・パディングを調整可能
- ⚡ **倍速モード** — 完全削除する代わりに 2x / 4x / 8x で残せる
- 🚀 **再エンコードなし書き出し** — `-c copy` で高速＆画質ロスゼロ（カットだけの場合）
- 🎬 **ライブプレビュー** — ドラッグ中に動画フレームが追従、書き出し前の確認も可
- 📏 **波形＋目盛り表示** — タイムラインで音声の山と時刻を一目で確認
- 🔍 **ズーム** — マウスホイールで拡大、長尺動画でも細かい調整が可能
- 🗺 **動画ミニマップ** — プレイヤー上に削除/倍速範囲を常時表示
- ⌨ **キーボードショートカット** — Space, ←/→, I/O マーカー, Ctrl+Z, P, Delete
- ↶ **Undo / Redo** — 履歴 80件
- 💾 **プロジェクト保存** — localStorage で自動、JSON export/import 対応
- 🔊 **音量正規化** — `-af loudnorm` で出力音量を統一（EBU R128 -16 LUFS）
- 📸 **フレーム保存** — 任意の瞬間を PNG で書き出し
- 📤 **複数形式書き出し** — MP4 / WebM / GIF、解像度オプション
- 🛑 **書き出しキャンセル** — 重い処理を途中で止められる
- 📱 **PWA 対応** — オフラインでも動く、インストール可能

## 動かす

### ローカル開発

```bash
npm install
npm run dev
# → http://localhost:5173
```

dev サーバは COOP/COEP ヘッダ込みで動くので、`ffmpeg.wasm` の SharedArrayBuffer もそのまま動きます。

### プロダクションビルド

```bash
npm run build       # dist/ に出力
npm run preview     # ビルド済みファイルをローカルでプレビュー
```

### Vercel にデプロイ

```bash
npm i -g vercel
vercel              # 初回。プロジェクト紐付け
vercel --prod       # 本番デプロイ
```

`vercel.json` で COOP/COEP ヘッダが自動設定されるので、デプロイ後そのまま動きます。

## アーキテクチャ

100% クライアントサイド。動画データはサーバーに一切送られません。

```
┌─────────────────────────────────────────┐
│  Browser (Chrome / Edge / Safari)        │
│                                          │
│  ┌────────────┐  ┌────────────────────┐ │
│  │ Vite app   │  │ ffmpeg.wasm worker │ │
│  │ (~33 KB)   │←→│ (32 MB, cached)    │ │
│  └────────────┘  └────────────────────┘ │
│         ↓                ↓                │
│  ┌─────────────────────────────────────┐│
│  │ User's video file (in-memory only) ││
│  └─────────────────────────────────────┘│
└─────────────────────────────────────────┘
```

### スタック

- **Vite** (5.x) — 開発サーバとビルド
- **ffmpeg.wasm** (`@ffmpeg/ffmpeg` 0.12.x + `@ffmpeg/core` 0.12.x ESM) — 動画処理
- **Web Audio API** — 波形描画、無音検出
- **Canvas 2D** — 波形＋目盛り描画
- **vanilla JS** — フレームワークなし

### ディレクトリ構成

```
src/
├── main.js          # オーケストレーション・キーボード・UI イベント
├── timeline.js      # タイムライン描画、ドラッグ操作、ズーム、履歴
├── exporter.js      # ffmpeg.wasm 統合、ストリームコピー/再エンコード
├── silence.js       # 無音検出アルゴリズム
├── storage.js       # localStorage + JSON プロジェクト保存
├── settings.js      # ユーザー設定の永続化
├── thumbnails.js    # フレームサムネ生成（未統合）
└── style.css        # スタイル全部
public/
├── ffmpeg/          # ffmpeg-core.js + ffmpeg-core.wasm
├── icons/           # PWA アイコン
├── manifest.webmanifest
└── sw.js            # Service worker（オフラインキャッシュ）
```

## 動作要件

- **Chrome / Edge / Firefox** 最新版（Safari は AudioContext の挙動差で一部動作確認中）
- WebAssembly + SharedArrayBuffer 対応ブラウザ
- 4GB+ RAM 推奨（大きな動画を扱う場合）

## ライセンス

MIT (TBD)

## ロードマップ

- [ ] マルチクリップ対応（複数動画の結合トリミング）
- [ ] Whisper.wasm による「えーと」検出
- [ ] サムネイルストリップ表示
- [ ] 設定の同期（ブラウザ間）
- [ ] 有料プラン（4K対応・長尺・AI機能）
