# Plan-First Workflow Design

## 1. 目的

本メモは、Codex Remote Web Client に
「スレッド単位で plan-first に進め、ユーザーが plan を承認したら実装へ進む」
体験を追加するための調査結果と設計方針を整理する。

目的は以下の 3 点。

- Codex app-server / Codex CLI の思想に寄せる
- protocol に無理な前提を置かない
- v1 で実装すべき責務と、将来拡張の境界を明確にする

## 2. 前提

- 対象 runtime は `codex app-server` 経由の real mode
- 対象確認バージョンは `codex-cli 0.116.0`
- 確認日は 2026-03-29
- 根拠は以下
  - OpenAI Codex docs
  - `codex app-server generate-ts`
  - `codex app-server generate-json-schema`
  - 現在の本リポジトリ実装

## 3. 結論

### 3.1 protocol 上、plan surface は存在する

Codex app-server には plan 関連 surface が存在する。

- thread item としての `plan`
- notification としての `item/plan/delta`
- notification としての `turn/plan/updated`

さらに、`turn/start` の生成 TypeScript 型には
`collaborationMode?: { mode: "plan" | "default", ... }`
が含まれている。

したがって、plan-first 体験は Codex の思想から外れた独自概念ではない。
ただし、確認できた surface は主に turn 単位であり、
「thread 自体が protocol 上で永続的に plan mode を持つ」とまでは言えない。

### 3.2 推奨は「thread-level の UX 設定」+「turn-level の実行」

ユーザー体験としてはスレッド単位で
`plan-first` を持たせてよい。
ただし protocol への反映は turn ごとに行うべきである。

つまり以下の分離が自然。

- アプリの session/thread 設定:
  - このスレッドは plan-first で進めたい
- Codex への実行時反映:
  - planning turn は `plan` 寄りで開始
  - implementation turn は通常モードで開始

この分離により、UI/UX 上は thread-level に見せつつ、
Codex の turn-centric な流れに沿える。

### 3.3 「plan 承認」と「権限承認」は分けるべき

一番重要なのはここである。

ユーザーが plan を承認しても、それは
「この方針で実装に進んでよい」という product-level 承認であり、
Codex の command / file change / permission 要求を自動承認したことにはならない。

Codex の思想に沿うなら、承認は 2 層に分けるべき。

- product workflow 承認
  - plan を approve して implementation turn を開始する
- runtime permission 承認
  - command 実行
  - file change
  - 追加 filesystem/network permission
  - tool input / MCP elicitation

## 4. Codex の思想に沿う設計原則

### 4.1 thread ではなく turn が主たる実行単位

app-server docs でも conversation は
thread -> turn -> item
で整理されている。

したがって「plan 承認後に同じ turn が裏でそのまま実装へ移る」よりも、
承認後に新しい implementation turn を明示的に開始する方が自然である。

### 4.2 approval は action boundary で効く

Codex docs では、approval policy / sandbox policy を設定しつつ、
必要に応じて approval request が client に返ってくる。

このため、plan approved 後も以下は別途発火しうる。

- command 実行 approval
- file change approval
- 追加 permission request
- tool input request

つまり plan approval は
「実装に進んでよい」
であって
「以後の危険操作を全部無条件許可」
ではない。

### 4.3 danger-full-access を既定にしない

Codex docs 上の標準的な思想は、
リスクに応じて sandbox / approval を調整することにある。

そのため remote web client でも既定値は以下が自然。

- `workspace-write + on-request`

必要に応じて以下を選べるようにする。

- `read-only`
- `danger-full-access`

ただし `danger-full-access` は advanced setting の明示 opt-in に寄せるべきである。

## 5. Protocol 調査メモ

### 5.1 app-server は双方向 protocol

app-server は JSON-RPC ベースの双方向 protocol であり、
client は request を送るだけでなく、
server からの request にも応答する責務がある。

この点は重要で、approval / request_user_input は
notification ではなく server request として来る。

### 5.2 plan に関する surface

確認できた主なもの:

- `turn/plan/updated`
- `item/plan/delta`
- thread item `type: "plan"`

生成 TypeScript では `TurnStartParams.collaborationMode` が存在し、
`mode` は `"plan" | "default"` である。

補足:

- JSON Schema bundle と generated TS で一部不整合があった
- `collaborationMode` は generated TS では確認できたが、
  JSON Schema の top-level properties には落ちていなかった
- したがって v1 では experimental / feature-detect 前提で扱うのが安全

### 5.3 approval / user input に関する surface

server request として以下が存在する。

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`

特に `item/permissions/requestApproval` は、
追加の filesystem / network permission を要求できる。
response では `scope: "turn" | "session"` を返せる。

これは remote client にとって非常に重要で、
「今回だけ許可」「この session 中は許可」という UI が素直に作れる。

## 6. 現状実装との差分

本リポジトリの現状は、Codex の思想にかなり逆らっている部分がある。

### 6.1 approval policy / sandbox が固定されている

`apps/bridge/src/codex/real-client.ts` では、
`thread/start` / `thread/resume` に以下を固定で渡している。

- `approvalPolicy: "never"`
- `sandbox: "danger-full-access"`

このため、いまの remote client は
「plan を approve したら実装」
以前に、
「最初から全部フル権限」
に寄っている。

### 6.2 server request を bridge が reject している

同じく `apps/bridge/src/codex/real-client.ts` では、
server からの request を未対応として reject している。

そのため現状では以下を受けられない。

- command approval
- file change approval
- permission request
- request_user_input
- MCP elicitation

つまり、Codex が本来持っている approval flow を
remote web client がまだ実装していない。

### 6.3 plan は履歴表示できるが live relay が足りない

本リポジトリでは `plan` message kind 自体は存在し、
thread item の `plan` を catalog 化して UI 表示できる。

ただし live では `turn/plan/updated` を relay していないため、
planning UX としてはまだ十分ではない。

## 7. 推奨プロダクト仕様

### 7.1 用語

以下の 2 つを分ける。

- workflow mode
  - session/thread が plan-first で進むかどうか
- execution permissions
  - Codex が runtime 中に何をどこまで実行できるか

### 7.2 session/thread 単位で持つ状態

アプリ側の session metadata として、最低限以下を持つのがよい。

- `workflowMode`
  - `"default" | "planFirst"`
- `workflowState`
  - `"planning" | "readyToImplement" | "implementing"`
- `approvedPlan`
  - 最新承認 plan の snapshot
- `approvedPlanTurnId`
  - どの turn の plan を承認したか
- `approvedAt`
  - 承認時刻

重要:

- これは Codex protocol の canonical state ではなく、
  remote client の product state である
- v1 では local DB に持てば十分

### 7.3 planning turn の開始

session が `workflowMode = "planFirst"` の場合、
新しい planning turn は以下の方針で開始する。

1. `collaborationMode.mode = "plan"` が使える場合はそれを使う
2. 使えない場合は通常 turn に加えて
   planning 指示を developer/base instruction 側で補う

期待する振る舞いは以下。

- まず問題整理
- 実装案
- リスク
- step-by-step plan
- まだ勝手に実装しない

### 7.4 plan 承認後の実装開始

推奨 UX は以下。

1. planning turn が完了する
2. ユーザーが plan を確認する
3. ユーザーが `Approve and implement` を押す
4. アプリが同じ thread 上で新しい implementation turn を開始する

この時点では planning turn を継続させるのではなく、
新しい turn を切る。

理由:

- Codex の turn-centric なモデルに沿う
- 「どの plan を承認して、どの turn から実装が始まったか」が明確
- audit / history 上も追いやすい
- 途中で plan 修正した場合の整合性が高い

### 7.5 implementation turn の開始条件

implementation turn の開始時は以下を推奨する。

- `workflowState = "implementing"`
- `collaborationMode.mode = "default"` を優先
- approved plan の要約を context として渡す
- user-facing input は明示的に
  「承認済み plan に基づいて実装を開始してください」
  とする

ここで重要なのは、
implementation 開始を implicit にせず、
明示的な user turn として残すことである。

### 7.6 plan 修正

plan approved 後でも以下は許可してよい。

- `Revise plan`
- `Back to planning`
- `Discard approved plan`

ただし approved plan は常に 1 つだけ current とし、
新しい承認が入ったら previous を履歴扱いにするのが分かりやすい。

## 8. 権限設計

### 8.1 推奨既定値

v1 の既定値は以下を推奨する。

- approval policy: `on-request`
- sandbox: `workspace-write`

補足:

- 未信頼 repo や onboarding 直後は `read-only` 開始も有力
- `danger-full-access` は advanced setting へ退避

### 8.2 plan approval と permission approval を混同しない

`Approve and implement` は
implementation turn の開始だけを意味する。

その後の runtime 中に、必要なら別途以下を出す。

- command approval dialog
- file change approval dialog
- additional permission dialog
- request user input dialog

この分離が Codex に最も沿う。

### 8.3 additional permission request の扱い

`item/permissions/requestApproval` では、
追加 read/write root や network enablement が要求されうる。

UI では以下をそのまま見せるべき。

- read access を求めている path
- write access を求めている path
- network access の要否
- reason
- 適用 scope
  - this turn only
  - this session

### 8.4 v1 でやらない方がよいこと

以下は v1 で避けるのがよい。

- plan approved 後に runtime approvals を自動で全部許可する
- thread-level plan mode を protocol の絶対的真実として扱う
- same turn の中で planning から implementation へ自動遷移する

## 9. UI 仕様案

### 9.1 session header

thread header 付近に以下を出す。

- workflow badge
  - `Plan First`
- current state
  - `Planning`
  - `Ready to implement`
  - `Implementing`

### 9.2 planning 完了後の action

planning turn の完了後、approved plan が無い場合は以下を出す。

- `Approve and implement`
- `Request revision`
- `Continue planning`

`Approve and implement` で new turn を開始する。

### 9.3 approved plan banner

approved plan がある場合、chat 上部に compact banner を出す。

表示内容の例:

- `Approved plan from 11:42`
- 対象 turn へのジャンプ
- `Revise`
- `Implement again`

### 9.4 runtime approval dialogs

approval request は bottom sheet / modal で扱う。

必要な種別:

- command execution approval
- file change approval
- additional permission approval
- request_user_input
- MCP elicitation

## 10. 実装方針

### 10.1 bridge

bridge では以下が必要。

- `thread/start` / `thread/resume` の固定値を外す
- session/thread 設定に応じて approval policy / sandbox を決める
- `turn/start` に plan-first 用 override を渡せるようにする
- server request を受け、web client に relay し、response を app-server へ返す
- `turn/plan/updated` と `item/plan/delta` を relay する

### 10.2 shared types

最低限、以下の型拡張が必要。

- session workflow metadata
- live plan update event
- approval request event
- approval response payload
- request_user_input payload

### 10.3 web

web では以下が必要。

- session/thread settings UI
- plan review UI
- approve and implement action
- runtime approval dialogs
- request_user_input form

### 10.4 persistence

v1 では session DB に保存すれば十分。

候補:

- session table に workflow columns を追加
- approved plan snapshot 用の別 table を追加

v1 時点では Codex thread metadata へ無理に寄せなくてよい。
remote client 独自の workflow state と割り切った方が安全である。

## 11. 推奨 v1 スコープ

最初の実装範囲は以下を推奨する。

1. `workflowMode = planFirst` の session 設定を追加
2. `turn/plan/updated` と `plan` item の live 表示を追加
3. `Approve and implement` を new turn として実装
4. approval policy / sandbox の既定を
   `workspace-write + on-request` へ変更
5. server request による runtime approval flow を実装

逆に、以下は v2 以降でよい。

- plan revision diff の高度表示
- multiple approved plans の履歴 UI
- auto-approval policy の細かなテンプレート化
- collaborative / multi-agent planning 固有 UX

## 12. 最終提案

ユーザー要望の
「スレッド単位でプランモードみたいに設定して、approve したら実装開始する」
は、Codex の思想に十分沿う形で実現できる。

ただし、実装の形は以下が望ましい。

- 見せ方は thread-level
- 実行は turn-level
- plan approval と permission approval は分離
- implementation 開始は new turn
- runtime permissions は `on-request` を維持

この形なら、
remote client として分かりやすく、
Codex 本来の approval / sandbox / turn lifecycle を壊さない。

## 13. 参考

- OpenAI Codex App Server
  - https://developers.openai.com/codex/app-server
- OpenAI Codex Agent approvals & security
  - https://developers.openai.com/codex/agent-approvals-security
- OpenAI Codex Advanced configuration
  - https://developers.openai.com/codex/config-advanced

