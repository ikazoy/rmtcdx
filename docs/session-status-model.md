# Session Status Model

このドキュメントは、`rmtcdx` における session status の意味と導出ルールを整理する。

前提となる同期フローは
[`docs/session-list-detail-sync-sequence.md`](./session-list-detail-sync-sequence.md)、
unread overlay は
[`docs/session-unread-state-design.md`](./session-unread-state-design.md)
を参照する。

## Why This Exists

現在の session state には、少なくとも次の 3 種類の情報が混ざっている。

- `codex app-server` の passive な thread snapshot
- `bridge` が live に観測した run state
- unread / pending request のような UI overlay

特に `interrupted` は誤読しやすい。

- `thread/read` の latest turn が `interrupted` でも、
  それがこの `bridge` で stop した結果とは限らない
- 他 client でまだ動いている、あるいは正常終了した session が、
  passive snapshot 上だけ `interrupted` に見える場合がある
- 一方で、user には `Interrupted` が「止めた」「失敗寄り」「注意が必要」を強く連想させる

そのため V1.5 の方針として、
`Interrupted` は「確認済み interrupt」に限定し、
snapshot-only な interrupt は user-facing status にそのまま出さない。

## Goals

- 初見でも session status の source of truth を追える
- `running` / `completed` / `interrupted` / `error` の意味を安定させる
- false positive な `Interrupted` を最小化する
- unread, pending request, archive 可否を execution status から分離する
- list, detail, filter, banner の表示ルールを揃える

## Non-goals

- `codex app-server` の snapshot semantics 自体を修正すること
- 過去の全 session について historical truth を完全復元すること
- multi-client の ownership を厳密に判定すること

## State Layers

session state は 4 層に分けて扱う。

| Layer | Owner | 主な field | 用途 |
|---|---|---|---|
| Raw snapshot | `catalog` | `latestTurnStatus`, `threadStatusType`, raw `session.status` candidate | Codex 側 snapshot の現在値 |
| Live run overlay | `RunService` | `activeRun`, `latestRun`, interrupt confirmation | `bridge` が live に知っている事実 |
| Attention overlay | `SessionUnreadService` + pending request presenter | `unreadCount`, `hasUnreadCompletion`, `hasUnreadError`, `pendingRequestCount` | badge, filter, attention tone |
| User-facing projection | `bridge` presenter + web UI | displayed status, banner copy, filter membership | user が見る最終状態 |

重要なのは、
raw snapshot と user-facing status を同一視しないこと。

## Vocabulary

### Raw Snapshot

`codex app-server` の `thread/list` / `thread/read` が返す状態。

- `thread.status.type`
  - `active` / `idle` / `notLoaded` / `systemError`
- `latestTurn.status`
  - `inProgress` / `completed` / `interrupted` / `failed`

これは「Codex 側 snapshot が今そう見えている」ことを表す。
それだけでは interrupt の provenance は分からない。

### Live Run Evidence

この `bridge` が WebSocket / app-server notification で live に観測した情報。

- local active run
- live terminal event
- local stop request

これは snapshot より user-facing status に使う価値が高い。

### Confirmed Interrupted

次のどちらかを満たす interrupted。

- この `bridge` が stop request を出した
- この `bridge` が live terminal event として interrupted を観測した

user-facing では普通の `Interrupted` として扱う。
local stop かどうかは copy の出し分けだけに使ってよいが、
色や filter や archive 判定には使わない。

### Snapshot-only Interrupted

live な interrupt 証拠が無いのに、
passive snapshot だけが `latestTurnStatus = interrupted` を返している状態。

これは

- 他 client がまだ active
- 他 client で完了したが snapshot が不安定
- 本当に remote interrupt されたが bridge は live event を見ていない

のいずれかであり、
V1.5 では user-facing `Interrupted` に直結させない。

## Why Current Fields Are Not Enough

現在の `statusReasonCode` / `statusConfidence` だけでは、
user-facing interrupt を決めるのに情報が足りない。

- `latest_turn_interrupted`
  - raw snapshot の latest turn が interrupted だった、という意味に過ぎない
- `authoritative`
  - snapshot の読み取りが authoritative という意味であり、
    interrupt provenance が確認済みという意味ではない
- `suspicious`
  - 現在は `inProgress` + inactive の heuristic にしか使っていない
  - snapshot-only interrupted を区別する用途には足りない

したがって、
interrupt には専用の evidence 概念を持たせる。

## Proposed Evidence Model

backend の canonical detail / summary では、
少なくとも次の区別を持つ。

```ts
type InterruptEvidence = "confirmed" | "snapshot_only" | null;
```

意味は次の通り。

- `confirmed`
  - local stop request または live terminal interrupted を bridge が観測した
- `snapshot_only`
  - passive snapshot にしか interrupted の根拠が無い
- `null`
  - latest run が interrupted ではない

必要なら copy 用に次も追加してよい。

```ts
type InterruptOrigin = "local_request" | "non_local_or_unknown" | null;
```

ただし `InterruptOrigin` は文言専用であり、
色、filter、archive 可否には使わない。

## Core Policy

### 1. `Interrupted` は confirmed case に限定する

user-facing status として `Interrupted` を表示してよいのは、
`InterruptEvidence = confirmed` のときだけ。

### 2. snapshot-only interrupted は user-facing で downgrade する

`InterruptEvidence = snapshot_only` のとき、
display status は次のどちらかに寄せる。

- active の証拠があるなら `Running`
- それ以外は `Completed`

ここでいう active の証拠は次を含む。

- canonical `activeRun !== null`
- `threadStatusType === "active"`
- 同一 session に pending request がある

判定手順は次の順序で固定する。

```ts
if (interruptEvidence !== "snapshot_only") {
  // snapshot-only 以外は通常の terminal / active ルールを使う
}

if (activeRun !== null) {
  return "running";
}

if (threadStatusType === "active") {
  return "running";
}

if (pendingRequestCount > 0) {
  return "running";
}

return "completed";
```

`pendingRequestCount` は通常時の execution status を上書きするための signal ではない。
ただし snapshot-only interrupted だけは terminal truth が曖昧なので、
「まだ session が動いている / user input を待っている」補助 evidence としてのみ使う。

### 3. unread / pending request は execution status を上書きしない

- unread は badge / filter / attention tone だけを変える
- pending request は pending indicator を出すが、execution status そのものは変えない

### 4. archive 可否は active 実行だけで決める

archive / restore の disable 判定は canonical `activeRun` のみを見る。

- confirmed interrupted
- snapshot-only interrupted
- completed
- unread completion

はいずれも archive の妨げにしない。

## Canonical Derivation Order

session status は次の順で導出する。

1. `catalog`
   - raw snapshot を読む
2. `RunService`
   - local active/latest run と terminal evidence を reconcile する
3. session presenter
   - interrupt evidence を含む canonical execution status を作る
4. `SessionUnreadService`
   - unread overlay を付与する
5. app/web
   - pending request indicator と copy を付与する

endpoint ごとに別経路で `activeRun` / `latestRun` を再合成しない。

## User-facing Decision Table

| Inputs | Display status | Notes |
|---|---|---|
| `isArchived = true` | `Archived` | execution status より優先 |
| `activeRun !== null` | `Running` | strongest signal |
| latest terminal = `error` | `Error` | confirmed terminal |
| latest terminal = `completed` | `Completed` | confirmed terminal |
| latest terminal = `interrupted` and `InterruptEvidence = confirmed` | `Interrupted` | yellow tone |
| latest turn snapshot = `completed` and no stronger live evidence | `Completed` | passive but safe |
| latest turn snapshot = `failed` and no stronger live evidence | `Error` | passive but safe |
| latest turn snapshot = `interrupted` and `InterruptEvidence = snapshot_only` and active hints exist | `Running` | avoid false interrupted while another client may still be active |
| latest turn snapshot = `interrupted` and `InterruptEvidence = snapshot_only` and no active hints exist | `Completed` | conservative non-alarm fallback |
| latest turn snapshot = `inProgress` and `threadStatusType = active` | `Running` | normal active snapshot |
| latest turn snapshot = `inProgress` and `threadStatusType != active` | `Running` | do not surface as interrupted; another client may own the active turn |

最後の 2 行の意図は同じで、
「active / in-progress 系の曖昧さは `Running` に倒す」。

## UI Rules

### Sidebar List

- session row の main status は canonical display status を使う
- `Interrupted` filter には confirmed interrupted だけを含める
- snapshot-only interrupted は `Interrupted` filter に入れない

### Detail Header / Banner

- yellow interrupted banner は confirmed interrupted のときだけ出す
- snapshot-only interrupted は banner を出さない
- 必要なら debug popover にだけ raw snapshot を表示する

### Copy

confirmed interrupted の copy は 2 種類あってよい。

- local stop request が分かる
  - `Run stopped`
- それ以外
  - `Run interrupted`

ただし両者とも同じ色、同じ filter、同じ archive rule にする。

### Attention Tone

execution status とは別に attention tone を持つ。

- pending request
- unread completion
- unread error

これは execution status を置き換えない。
たとえば `Completed + unread completion` は成立してよい。

## Tradeoff

この仕様は false positive な `Interrupted` を減らす代わりに、
remote interrupt を live に見逃した場合、
snapshot-only interrupted を `Completed` と表示することがある。

V1.5 ではこの tradeoff を許容する。
理由は次の通り。

- `Interrupted` は user にとって意味が強すぎる
- 実害は false negative より false positive の方が大きい
- raw snapshot は debug 情報として残せる
- multi-client provenance を完全に復元することは現状できない

## Examples

### 1. Stop button を押した

- local stop request を記録
- latest run が interrupted で終了
- `InterruptEvidence = confirmed`
- display status = `Interrupted`

### 2. 別 client が実行中で、passive snapshot だけ interrupted

- local live evidence なし
- raw latest turn = interrupted
- `threadStatusType = active` または他の active hint あり
- `InterruptEvidence = snapshot_only`
- display status = `Running`

### 3. 別 client で完了したが、passive snapshot だけ interrupted

- local live evidence なし
- raw latest turn = interrupted
- active hint なし
- `InterruptEvidence = snapshot_only`
- display status = `Completed`

### 4. 別 client が止めたが bridge は live terminal event を見た

- local stop request なし
- live terminal interrupted を観測
- `InterruptEvidence = confirmed`
- display status = `Interrupted`

## Implementation Notes

- `session.status` は raw upstream status ではなく、
  canonical user-facing display status として扱う
- raw snapshot を失わないため、
  `latestTurnStatus`, `threadStatusType`, `statusReasonCode`, `statusConfidence`
  は debug / diagnostics 用に保持する
- `statusReasonCode = latest_turn_interrupted` だけでは
  user-facing `Interrupted` を出さない
- summary と detail は同じ presenter ルールを共有する

## Acceptance Criteria

- 他 client 起点の曖昧な session が `Interrupted` filter に混ざらない
- false positive な yellow interrupted banner が出ない
- confirmed interrupted は従来どおり yellow で出る
- archive 可否が snapshot-only interrupted に引きずられない
- debug では raw snapshot と evidence を追える
