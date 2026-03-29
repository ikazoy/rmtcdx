# Execution Permissions Design

## 1. 目的

本メモは、Codex Remote Web Client における
execution permission / approval / sandbox 設計を整理する。

本書は、

- 実行コマンドの許可レベル
- file change 承認
- 追加 filesystem / network permission
- request_user_input / MCP elicitation

を対象とする。

plan-first workflow 自体の設計は
`docs/plan-first-workflow-design.md` に分離する。

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

### 3.1 permission surface は protocol に存在する

execution permission は protocol に存在する。

大きく 2 層ある。

- 設定としての policy
  - `thread/start` / `thread/resume` の `approvalPolicy` と `sandbox`
  - `turn/start` の `approvalPolicy` と `sandboxPolicy`
- 実行中の approval request
  - `item/commandExecution/requestApproval`
  - `item/fileChange/requestApproval`
  - `item/permissions/requestApproval`
  - `item/tool/requestUserInput`
  - `mcpServer/elicitation/request`

つまり、
「最初からどういう policy で始めるか」と
「実行中に追加承認をどう受けるか」の両方が protocol にある。

### 3.2 plan approval と runtime permission approval は別物

`Approve and implement` は workflow 承認であり、
execution permission を一括承認するものではない。

Codex の思想に沿うなら、plan approval 後も
必要なら runtime approval を別途出すべきである。

### 3.3 remote web client の既定値は保守的にする

推奨既定値は以下。

- approval policy: `on-request`
- sandbox: `workspace-write`

補足:

- 未信頼 repo や onboarding 直後は `read-only` 開始も有力
- `danger-full-access` は advanced setting へ退避

## 4. Protocol 調査メモ

### 4.1 app-server は双方向 protocol

app-server は JSON-RPC ベースの双方向 protocol であり、
client は request を送るだけでなく、
server からの request に応答する責務を持つ。

approval / request_user_input は
notification ではなく server request として来る。

### 4.2 start 時の policy surface

確認できた主な surface:

- `thread/start`
  - `approvalPolicy`
  - `approvalsReviewer`
  - `sandbox`
- `thread/resume`
  - `approvalPolicy`
  - `approvalsReviewer`
  - `sandbox`
- `turn/start`
  - `approvalPolicy`
  - `approvalsReviewer`
  - `sandboxPolicy`

`approvalPolicy` は以下の enum / 形式を持つ。

- `untrusted`
- `on-failure`
- `on-request`
- `never`
- granular object

granular 形式では少なくとも以下を切り分けられる。

- `mcp_elicitations`
- `rules`
- `sandbox_approval`
- `request_permissions`
- `skill_approval`

### 4.3 runtime approval surface

server request として以下が存在する。

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`

特に `item/permissions/requestApproval` は、
追加の filesystem / network permission を要求できる。

response では `scope: "turn" | "session"` を返せる。

### 4.4 additional permission の中身

`item/permissions/requestApproval` では概ね以下を扱える。

- fileSystem.read
- fileSystem.write
- network.enabled
- reason

したがって UI では、
「何をしたいか」ではなく
「どの path / network をどの scope で許可するか」
をそのまま表示するのが自然である。

## 5. 現状実装との差分

### 5.1 approval policy / sandbox が固定されている

`apps/bridge/src/codex/real-client.ts` では、
`thread/start` / `thread/resume` に以下を固定で渡している。

- `approvalPolicy: "never"`
- `sandbox: "danger-full-access"`

このため、現状の remote client は
Codex 本来の approval model をほぼ迂回している。

### 5.2 server request を bridge が reject している

同じく `apps/bridge/src/codex/real-client.ts` では、
server からの request を未対応として reject している。

そのため現状では以下を受けられない。

- command approval
- file change approval
- additional permission request
- request_user_input
- MCP elicitation

### 5.3 web / shared types に approval 用 surface が無い

現状の shared types / realtime event は、
message / activity / run 更新には対応しているが、
approval request / response を運ぶ surface を持っていない。

そのため UI に permission dialog を出す経路がまだ無い。

## 6. 推奨プロダクト仕様

### 6.1 既定値

v1 の既定値は以下を推奨する。

- trusted repo
  - `workspace-write + on-request`
- untrusted repo または初回
  - `read-only`
- advanced opt-in
  - `danger-full-access`

### 6.2 承認の粒度

承認は以下のレイヤに分ける。

- command execution approval
- file change approval
- additional permission approval
- request_user_input
- MCP elicitation

これらを 1 つの「許可しますか」UI に潰さない方がよい。

### 6.3 additional permission の scope

`item/permissions/requestApproval` の response scope に合わせて、
UI では以下を分ける。

- this turn only
- this session

### 6.4 plan workflow との関係

`Approve and implement` は implementation turn を開始するだけであり、
以後の runtime approval をスキップしない。

この分離が Codex に最も沿う。

## 7. UI 仕様案

### 7.1 settings surface

session/thread settings または repo settings で以下を設定可能にする。

- default sandbox level
- default approval policy
- advanced mode enablement

### 7.2 approval dialog

approval request は bottom sheet / modal で扱う。

必要な種別:

- command execution approval
- file change approval
- additional permission approval
- request_user_input
- MCP elicitation

### 7.3 additional permission dialog

dialog では以下を明示する。

- read access を求めている path
- write access を求めている path
- network access の要否
- reason
- 適用 scope
  - this turn only
  - this session

## 8. 実装方針

### 8.1 bridge

bridge では以下が必要。

- `thread/start` / `thread/resume` の固定値を外す
- session/thread 設定に応じて approval policy / sandbox を決める
- `turn/start` に per-turn override を渡せるようにする
- server request を受け、web client に relay し、response を app-server へ返す

### 8.2 shared types

最低限、以下の型拡張が必要。

- approval request event
- approval response payload
- request_user_input payload
- settings / policy metadata

### 8.3 web

web では以下が必要。

- runtime approval dialogs
- request_user_input form
- session/thread settings UI

## 9. 推奨 v1 スコープ

最初の実装範囲は以下を推奨する。

1. approval policy / sandbox の既定を
   `workspace-write + on-request` に変更
2. server request の relay / response を実装
3. command / file / permission / input の dialog を実装
4. turn / session scope を含む permission UI を実装

逆に、以下は v2 以降でよい。

- granular policy のテンプレート保存
- repo trust model の高度化
- guardian reviewer 的な高度承認フロー

## 10. 最終提案

execution permission は plan workflow と完全に別責務として扱うべきである。

設計の形としては以下がよい。

- plan-first は workflow doc に分離
- approval / sandbox / request_user_input は本書に集約
- runtime approval は Codex の native flow に寄せる
- `danger-full-access` は既定にしない

この形なら、
remote client としての分かりやすさを保ちつつ、
Codex 本来の approval / sandbox の思想を壊さない。

## 11. 参考

- OpenAI Codex App Server
  - https://developers.openai.com/codex/app-server
- OpenAI Codex Agent approvals & security
  - https://developers.openai.com/codex/agent-approvals-security
- OpenAI Codex Advanced configuration
  - https://developers.openai.com/codex/config-advanced

