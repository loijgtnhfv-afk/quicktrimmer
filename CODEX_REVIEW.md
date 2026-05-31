# Codex Cross-Review Plan

ローンチ前に Codex に投げて意地悪レビューしてもらうポイント。Claude が書いたコードを Codex に「敵対的に」見てもらう。

## セットアップ（一度だけ）

Claude Code 内で以下を実行：

```
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
/codex:setup
```

要件: Node.js 18.18+、ChatGPT サブスクか OpenAI API キー。

> **Windows 制約**: Computer Use は Mac 限定。CLI / レビュー / Rescue は問題なく動く。

---

## レビュー優先順位

### 🔴 P0: exporter.js（最重要）

複雑度が一番高い。FFmpeg のフィルタ文字列ビルド、stream-copy ↔ re-encode の自動切替、`atempo` の倍速チェーン、`loudnorm` 統合。1個壊れるとユーザーの動画が壊れる体験になる。

**実行**:
```
/codex:adversarial-review src/exporter.js
```

**気になっている具体点（プロンプトに含めてもいい）**:

1. `buildReencodeFilter` の `atempo` チェーン — 8倍速で `atempo=2.0,atempo=2.0,atempo=2.0` になるが、これでオーディオが本当にクリーンに 8倍速で同期されるか？
2. `loudnorm` を `[outa_pre]loudnorm=...[outa]` に挟む配置 — concat 後にかけているがチャンク間の音量差は均一化されるか？2-pass じゃなくて 1-pass で大丈夫か？
3. `computeKeepSegmentsCutsOnly` と `planSegments` の境界条件 — cursor が `r.end` を上書きしないケース（範囲が重複した場合の重複マージ）
4. `exportStreamCopy` の `-ss <start> -to <end> -i input.mp4 -c copy` で **キーフレーム前にカット位置がある場合**、再生開始フレームが黒くなる/オーディオがズレる事象（特に多くの動画では `-ss` 前置きが正しいがどこまで信頼できるか）
5. GIF パスで `-map [outa]` を `args.splice` で除去している処理 — splice インデックスが壊れる可能性
6. `cancelExport()` で `ff.terminate()` した後、次の `getFFmpeg()` で新規 worker を立ち上げる流れに leak がないか

---

### 🔴 P0: timeline.js（座標math）

ズーム導入で座標変換 (`xToTime` / `timeToX`) が全機能の土台になった。1px のズレが全機能に波及する。

**実行**:
```
/codex:adversarial-review src/timeline.js
```

**気になっている具体点**:

1. `onWheel` のズームクランプ — `viewport.start < 0` と `viewport.end > duration` を補正するが、両方同時に true になるケース（極端な小さい span で端に張り付いた状態）の挙動
2. `subtractFromRanges` — sub が r の境界とちょうど一致する場合の `<=` vs `<` 境界条件
3. `mergeRanges` — 連続する範囲で `type` と `speed` が同じ場合だけマージするが、ユーザーが手動で隣接する2つを片方 `cut`、片方 `speedup` にした場合の見た目と挙動が直感的か？
4. `pushHistory` の dedupe — `eqRanges` が `speed: undefined` と `speed: 2` を区別できるか
5. `drawTicks` の interval が極端なズーム（span < 0.5）で破綻しないか
6. リサイズ中の `notify()` 連発が `saveProject` 呼びまくる → localStorage 詰まり？

---

### 🟡 P1: silence.js

検出アルゴリズム本体。誤検出多すぎ/少なすぎは UX を直撃する。

**実行**:
```
/codex:adversarial-review src/silence.js
```

**気になっている点**:

1. `peak` 検出が `chunkSize` で離散化されてるが、`chunkSize` 境界でちょうど大きな音が瞬間的に出るケースを取り逃さないか
2. `padding` を端から引いてマイナスになるケース（短い無音区間で padding > 区間長/2）の安全性
3. ステレオ動画で左右の peak を比較せず両チャネルから個別に max を取ってる — `Math.max(left, right)` であるべき？それとも合算？

---

### 🟡 P1: storage.js + main.js（loadJsonInput のサニタイズ）

`parseProjectJson` で `JSON.parse` した結果を `addRanges` に渡している。main.js でスキーマ検証は入れたが、Codex に意地悪に見てもらうと別の穴が見つかるかも。

**実行**:
```
/codex:adversarial-review src/storage.js
/codex:adversarial-review src/main.js
```

**気になっている点**:

1. JSON ロード時のスキーマ検証は十分か？ `r.start`, `r.end` に `Infinity` / `NaN` が入った場合
2. `localStorage` 容量超過時のエラーハンドリング
3. `confirm()` を使った復元プロンプト — ブラウザがブロックする環境（自動化テストとか）でハマらないか

---

### 🟢 P2: ブラウザ互換性

Codex に直接見てもらうより、自分（人間）が Chrome / Firefox / Safari で動作確認するほうが速い。ただし、確認するポイントだけ Codex に「Safari でハマりそうな API はどれ？」と聞くのは有効。

**実行**:
```
/codex "src/ 配下のコードを見て、Safari で動かない可能性のある API 使用箇所をリストアップ。"
```

---

## 「rescue」を使うタイミング

Codex の `/codex:rescue` は **「特定のバグが再現するけど Claude では直せない」** 時に使うべき。今は再現バグないので待機。

ローンチ後にユーザーから「この動画だけ書き出し失敗する」みたいな再現困難バグが来た時に：

```
/codex:rescue "特定の MOV ファイル(添付)で書き出しが exit code 234 で失敗する。
原因と修正案をください。"
```

---

## レビュー結果の取り扱い

Codex の指摘は **「全部直す」ではなく「優先度をつける」** のが重要。レビュー結果のうち：

- **真のバグ** → 即修正
- **エッジケース指摘** → ユーザーがハマる可能性で判断（多くは無視でも問題ない）
- **スタイル/設計指摘** → ローンチ後に検討

Claude（このセッション）に「Codex がこう言ってきた、優先度どう思う？」と聞き返すのが効率的。

---

## ローンチまでの推奨フロー

```
1. /codex:setup
2. /codex:adversarial-review src/exporter.js          # 一番ヤバいやつ
3. /codex:adversarial-review src/timeline.js          # 次にヤバいやつ
4. /codex:adversarial-review src/silence.js           # 軽め
5. 出た指摘を Claude にフィードバックして優先度判断
6. P0 バグを修正
7. 再ビルド + npm run preview で目視確認
8. vercel --prod でデプロイ
9. デプロイ URL を Chrome / Firefox / Safari で開いて smoke test
10. リリース告知
```

合計時間目安: Codex レビュー 30分 + バグ修正 1〜2時間 + 検証 30分 = **半日**。
