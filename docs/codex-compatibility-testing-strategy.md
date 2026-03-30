# Codex Compatibility Testing Strategy

## 1. 目的

本メモは、Codex Remote Web Client が
`codex app-server` の protocol 変更に継続的に追従するための
テスト方針を整理する。

特に防ぎたいのは以下。

- Codex 側に新しい item type / notification が増えた瞬間に
  thread 全体が壊れる
- 1 つの unknown item のせいで UI が空になる
- live event は読めるのに read API だけ壊れる
- 逆に read API は読めるのに live event だけ壊れる
- 変更に気づくのが本番運用後になる

競合製品で見えた
「新しい item type で schema parse が壊れ、thread 表示が崩れる」
という失敗を、
他山の石として避けるための方針である。

## 2. 前提

- 対象 runtime は `codex app-server` 経由の real mode
- 対象確認バージョンは `codex-cli 0.116.0`
- 確認日は 2026-03-30
- 現在の本リポジトリ実装を前提にする

関連する主要実装:

- `apps/bridge/src/codex/real-client.ts`
- `apps/bridge/src/codex/types.ts`
- `apps/bridge/src/catalog/live-catalog-service.ts`
- `packages/shared-types/src/index.ts`
- `apps/bridge/src/observability/codex-debug-log.ts`

## 3. 現状認識

### 3.1 良い点

このリポジトリは、
競合製品より protocol drift に強い土台をすでに一部持っている。

- `CodexThreadItem` の末尾に `{ type: string; id: string }` があり、
  compile-time の union としては unknown item を受け止められる
- `real-client` は Zod で thread 全体を厳密 parse していないので、
  新しい field が増えても即 crash はしにくい
- `codex app-server` とのやり取りを
  `codex-app-server.jsonl` に記録できる

### 3.2 弱い点

ただし、
継続的互換性の観点では以下が弱い。

- `real-client` の request / response / notification 処理が
  raw `unknown` と ad-hoc cast に寄っている
- `mapItemToMessage()` は既知 item のみを表示し、
  unknown item を黙って `null` にする
- live notification と `thread/read` の両方をまたぐ
  回帰 fixture が無い
- Codex CLI 実機を使った smoke test が無い
- protocol drift を検知しても
  どの item / method / field が増えたのかを
  自動で分類する仕組みが無い

## 4. 結論

方針は以下の 4 本柱にする。

### 4.1 hard failure を避ける

互換性戦略の第一目標は
「全部を完全表示する」より先に
「未知のものが来ても thread 全体を壊さない」
に置く。

最低限守るべきルール:

- unknown item 1 つで thread 全体を落とさない
- unknown notification 1 つで run 全体を止めない
- 不明な item は `unknown item` として可視化するか、
  少なくとも structured log に残す
- parse 失敗は局所化する

### 4.2 fixture ベースで回帰を固定する

実機から取った sanitized fixture を
互換性テストの中心に置く。

対象は 2 系統。

- `thread/read` の response fixture
- live notification / event fixture

将来の変更は
「fixture を 1 個足したら壊れた」
という形で見えるようにする。

### 4.3 実機 smoke test を別レイヤで持つ

fixture だけでは
Codex CLI の最新版 drift を拾いきれない。

そのため、
opt-in の実機 smoke test を別レイヤで持つ。

- 日次 or release 前
- ローカルまたは CI の専用ジョブ
- 失敗したら fixture 化して回帰テストへ昇格

### 4.4 互換性は parser だけでなく degradation UX まで担保する

protocol 互換性は
「parse 成功」だけでは不十分である。

ユーザー体験として少なくとも以下を守る。

- thread 一覧が出る
- thread 詳細が開く
- user / assistant の主メッセージは読める
- 未知 item があっても既知 item は見える
- 送信と割り込みの主要導線が死なない

## 5. テストレイヤ

### 5.1 Layer A: pure shape tests

最も安く回るテスト。

対象:

- `CodexThreadItem` の既知 type 一覧
- `mapItemToMessage()` の既知 type mapping
- `activityFromItem()` と `toolName()` の mapping
- rate limit extractor

ここでは
既知 type ごとの期待出力を固定する。

目的:

- refactor で既知 type 対応を壊さない
- 新しい type を追加したときに
  既存 mapping へ影響が出ていないかを見る

### 5.2 Layer B: unknown tolerance tests

最重要レイヤ。

未知 input に対して、
どこまで壊れずに進めるかを明示的にテストする。

最低限必要なケース:

- unknown `CodexThreadItem.type`
- known item に unknown field が増える
- unknown notification `method`
- known notification に unknown field が増える
- item payload の一部 field が `null` / 欠落

期待値:

- exception を投げない
- 既知部分は表示できる
- unknown は drop するなら log される
- 可能なら placeholder message に変換される

### 5.3 Layer C: fixture-based transcript tests

real session から取った fixture を読み、
catalog まで通した結果を snapshot する。

テスト観点:

- session summary が作れる
- message list が作れる
- live activity が崩れない
- unread / latest excerpt / title 推定が壊れない

ここで固定すべきもの:

- `thread/read` fixture -> `SessionSummary`
- `thread/read` fixture -> `Message[]`
- event sequence fixture -> websocket / run 状態変化

### 5.4 Layer D: bridge-level smoke tests

mock backend ではなく、
fixture replay backend で bridge を立てる。

ここでは API surface を確認する。

- `GET /api/sessions`
- `GET /api/sessions/:id`
- `GET /api/messages`
- websocket の主要 event

目的:

- parser 単体ではなく app として壊れていないことを確認する

### 5.5 Layer E: real Codex canary tests

実機依存のため常時必須にはしない。

想定:

- 手元の upgrade 前チェック
- nightly job
- release candidate 前

最低限のシナリオ:

1. 新規 thread 作成
2. 短い prompt 送信
3. `thread/read` 取得
4. live notification 取得
5. debug log を保存

失敗した場合は、
fixture 化して Layer C に落とす。

## 6. どういう入力を fixture 化するか

fixture は「成功ケース」だけでは足りない。

### 6.1 必須 fixture

- userMessage + agentMessage だけの最小 thread
- reasoning / plan を含む thread
- commandExecution / fileChange を含む thread
- mcpToolCall / dynamicToolCall / collabAgentToolCall を含む thread
- webSearch / imageView / imageGeneration を含む thread
- review mode を含む thread
- interrupt / error / degraded ケース

### 6.2 drift 用 fixture

以下は意図的に人工生成してよい。

- `type: "futureUnknownType"`
- known item に余計な field を追加
- known item の optional field を削除
- notification method を未知にする

### 6.3 実機 fixture の取得元

現在の実装には
`codex-app-server.jsonl` を残す仕組みがある。

このログを fixture 取得元として使う。

推奨手順:

1. 実機で短い scenario を流す
2. `codex-app-server.jsonl` を保存する
3. 個人情報・path・prompt を sanitize する
4. replay 用 fixture に整形する

## 7. 実装方針

### 7.1 まず pure function に切り出す

今の `real-client.ts` は
child process 制御と protocol 解釈が密結合している。

互換性テストのためには、
まず以下を pure function として分離するのがよい。

- JSON-RPC notification -> `CodexBridgeEvent[]`
- raw thread item -> app message
- raw thread -> session summary / excerpt

これにより、
fixture を直接食わせるテストが書きやすくなる。

### 7.2 unknown item の扱いを仕様化する

unknown item を今のまま黙って捨てるのは弱い。

推奨は以下のどちらか。

- `kind: "protocol_notice"` や `kind: "unknown_item"` として UI に残す
- UI には出さなくても、
  `unknown item type encountered` を log / metric に残す

少なくとも後者は必須。

### 7.3 notification の default branch を監視可能にする

`handleNotification()` で未対応 method を黙って無視すると、
drift を見逃しやすい。

推奨:

- unknown notification を structured debug log に残す
- method 名の集計をできるようにする

### 7.4 fixture replay backend を用意する

mock backend は UX 開発には便利だが、
互換性テストには弱い。

そのため mock とは別に、
real fixture を返す replay backend を持つのがよい。

役割:

- `listThreads`
- `readThread`
- event stream replay
- 既知 drift fixture の再生

## 8. CI 方針

### 8.1 PR で必須にするもの

- Layer A
- Layer B
- Layer C

これらは network / Codex 実機に依存させない。

### 8.2 optional / scheduled にするもの

- Layer D の一部
- Layer E 全部

理由:

- Codex CLI の install 状態
- local account 状態
- rate limit
- 実行時間

の揺れが大きいからである。

### 8.3 failure 時の運用

CI で drift を検知したら、
以下の運用に固定する。

1. 失敗 fixture を保存する
2. どの method / item type が増えたかを分類する
3. まず hard failure を止める
4. 次に UI 表示対応を足す

## 9. 推奨ディレクトリ構成

以下のような構成が分かりやすい。

```text
apps/bridge/src/codex/
  parsers/
    bridge-events.ts
    thread-items.ts
    rate-limits.ts

apps/bridge/test/
  codex-compat/
    fixtures/
      codex-cli-0.116.0/
        thread-read-basic.json
        thread-read-tools.json
        notifications-basic.jsonl
        notifications-unknown-item.jsonl
    bridge-events.test.ts
    thread-items.test.ts
    fixture-replay.test.ts
```

ポイント:

- fixture 名に `codex-cli` version を入れる
- sanitize 済み raw payload を保つ
- expected output は snapshot か明示 object で固定する

## 10. 最初の 3 ステップ

現実的な着手順はこれがよい。

### Step 1

`real-client.ts` の notification 解釈を pure function に切り出す。

対象:

- `item/agentMessage/delta`
- `item/commandExecution/outputDelta`
- `item/started`
- `item/completed`
- `turn/completed`
- `error`

### Step 2

`live-catalog-service.ts` の
`mapItemToMessage()` を fixture テスト化する。

ここで以下を必須ケースにする。

- 全既知 item
- unknown item
- partial item

### Step 3

手元の `codex-app-server.jsonl` から
最小 fixture セットを作る。

最低限:

- normal text thread
- tools を含む thread
- reasoning / plan を含む thread
- unknown item を人工注入した thread

## 11. 非目標

本書は以下を直接は扱わない。

- protocol 変更を完全に先読みすること
- すべての新 item を即日 UI 対応すること
- OpenAI 側 schema と 1:1 で strict parse すること

互換性戦略の目的は、
「未知の変化で壊れないこと」と
「壊れてもすぐ検知して fixture 化できること」
に置く。

## 12. この方針で目指す状態

理想状態は以下。

- Codex 側に新 item が増えても thread は開く
- unknown item は少なくとも観測できる
- drift は実機運用前か直後に fixture で再現できる
- 回帰テストで同じ事故を二度起こさない

互換性は
「schema を厳密に縛ること」ではなく、
「変化を局所化し、観測し、素早く回帰テストへ落とすこと」
として設計するのがよい。
