# Codex Control Surface Design

## 1. 目的

本メモは、Codex Remote Web Client における
高度な Codex 制御面の設計方針を整理する。

対象は、
単なる prompt 送信 UI ではなく、
Codex app-server が本来持つ制御面を
どこまで、どういう順序で取り込むべきかである。

本書は上位方針を扱う。
詳細設計は以下に分離する。

- execution permission / approval / sandbox
  - `docs/execution-permissions-design.md`
- plan-first workflow
  - `docs/plan-first-workflow-design.md`

## 2. 前提

- 対象 runtime は `codex app-server` 経由の real mode
- 対象確認バージョンは `codex-cli 0.116.0`
- 確認日は 2026-03-30
- 根拠は以下
  - OpenAI Codex docs
  - `codex app-server generate-ts`
  - `codex --help`
  - 現在の本リポジトリ実装

## 3. 結論

### 3.1 Codex 側の capability は既に広い

Codex app-server / CLI 側には、
remote web client が将来的に使いたい主要 surface がほぼ揃っている。

主なもの:

- thread-level 設定
  - `model`
  - `approvalPolicy`
  - `approvalsReviewer`
  - `sandbox`
  - `personality`
- turn-level override
  - `model`
  - `sandboxPolicy`
  - `effort`
  - `summary`
  - `personality`
  - `outputSchema`
  - `collaborationMode`
- runtime request
  - command approval
  - file change approval
  - additional permission approval
  - `request_user_input`
  - MCP elicitation
- discovery / control API
  - `model/list`
  - `turn/steer`
  - `review/start`
  - `skills/list`
  - `plugin/list`
  - `configRequirements/read`

したがって、
今後の主課題は
「Codex にその機能があるか」ではなく、
「bridge / shared types / web がその surface をどう露出するか」である。

### 3.2 最大の欠落は bridge の双方向性

現在の bridge は、
実質的には app-server を
request sender + notification consumer としてだけ扱っている。

しかし app-server は本来、
server から client に request を返す双方向 protocol である。

このギャップのため、
現状では以下が成立しない。

- pending approval の解決
- pending user input の解決
- MCP elicitation の解決

ここを直さずに model switch や mode UI だけ増やしても、
高度な Codex 制御面としては完成しない。

### 3.3 取り込み順序は「可視化」よりも「成立条件」を優先する

推奨順序は以下。

1. runtime request を扱える bridge / state model を先に作る
2. current thread / turn settings を read-only で可視化する
3. create-time / turn-time override を追加する
4. plan-first / steer / review / plugin などを段階導入する

理由:

- approval / input 未対応のままでは、
  設定 UI を出しても実行が途中で詰まる
- current state の read model が無いと、
  編集 UI を作っても何が効いているか分からない
- plan-first や steer は、
  基本 control surface ができてからの方が設計が素直

### 3.4 product 上は thread-level に見せ、protocol には turn-level で反映する

多くの control は user experience 上、
session / thread 単位の設定として見せる方が自然である。

ただし protocol 上の実行単位は turn である。
そのため設計は以下を原則とする。

- product state
  - thread / session の設定として保持してよい
- protocol reflection
  - `thread/start` / `thread/resume` で thread default を反映
  - `turn/start` で turn override を反映

この分離は、
plan-first にも model / reasoning にも共通する。

## 4. Protocol で確認できた主要 surface

### 4.1 thread start / resume

`thread/start` と `thread/resume` には少なくとも以下がある。

- `model`
- `modelProvider`
- `serviceTier`
- `approvalPolicy`
- `approvalsReviewer`
- `sandbox`
- `baseInstructions`
- `developerInstructions`
- `personality`

response 側でも、
実際に採用された値として以下を受け取れる。

- `model`
- `modelProvider`
- `serviceTier`
- `approvalPolicy`
- `approvalsReviewer`
- `sandbox`
- `reasoningEffort`

したがって、
session detail の read model に
「現在有効な Codex 設定」を持つのは自然である。

### 4.2 turn start

`turn/start` には少なくとも以下の override がある。

- `cwd`
- `approvalPolicy`
- `approvalsReviewer`
- `sandboxPolicy`
- `model`
- `serviceTier`
- `effort`
- `summary`
- `personality`
- `outputSchema`
- `collaborationMode`

特に重要なのは以下。

- `effort`
  - reasoning effort
- `summary`
  - reasoning summary verbosity
- `collaborationMode`
  - plan-first 的 workflow と親和性が高い
- `outputSchema`
  - 将来的な structured response と相性がよい

### 4.3 turn steer

`turn/steer` により、
実行中 turn へ追加の user input を差し込める。

これは以下の UX に発展可能である。

- 走行中 run への補足指示
- 軌道修正
- pending 状態中の clarify

ただし `turn/steer` 自体は
turn-level override を持たないため、
設定変更の入口ではなく
active turn への介入手段として扱うべきである。

### 4.4 model / review / skills / plugins

protocol 上は以下も確認できる。

- `model/list`
- `review/start`
- `skills/list`
- `plugin/list`
- `plugin/read`
- `configRequirements/read`

したがって、
将来的には以下も remote client に取り込める。

- 利用可能 model 一覧の取得
- repo / task に対する review 専用起動
- skill / plugin の存在可視化
- feature / config requirement の診断

ただし v1 では必須ではない。

### 4.5 runtime request

server request として以下がある。

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`

response payload も型として存在する。

- `CommandExecutionRequestApprovalResponse`
- `FileChangeRequestApprovalResponse`
- `PermissionsRequestApprovalResponse`
- `ToolRequestUserInputResponse`
- `McpServerElicitationRequestResponse`

特に command approval は単純な accept / decline だけでなく、
以下まで含みうる。

- `acceptForSession`
- execpolicy amendment
- network policy amendment

つまり UI は、
単なる yes / no dialog では足りない可能性がある。

## 5. 現状実装との差分

### 5.1 start / resume の既定が固定されている

現状の `apps/bridge/src/codex/real-client.ts` では、
`thread/start` と `thread/resume` に以下を固定で渡している。

- `approvalPolicy: "never"`
- `sandbox: "danger-full-access"`

このため現在の remote client は、
Codex 本来の approval / sandbox モデルを
ほぼバイパスしている。

### 5.2 server request を bridge が reject している

同ファイルでは、
server からの request を未対応として reject している。

その結果、
以下の control surface が使えない。

- command approval
- file change approval
- additional permission request
- request_user_input
- MCP elicitation

### 5.3 run API が prompt 中心で settings surface を持たない

`RunService` と shared types の `CreateRunRequest` は、
現状では prompt と画像添付が中心であり、
turn-level override の面を露出していない。

欠けている代表例:

- model override
- reasoning effort / summary
- collaboration mode
- sandbox / approval override

### 5.4 realtime / shared types が pending request を運べない

現状の realtime gateway と shared types は、
以下の更新には対応している。

- run
- message
- activity
- backend degraded

しかし以下を運べない。

- pending approval request
- request_user_input
- MCP elicitation
- live plan update
- current Codex settings の変化

このため UI に
高度な control panel を載せる土台がまだ無い。

## 6. 設計原則

### 6.1 bridge は thin proxy ではなく protocol adapter として扱う

bridge の役割は、
単に JSON-RPC を forward することではない。

必要なのは以下である。

- app-server protocol を product state に写像する
- Web UI で扱いやすい read model を持つ
- pending request を queue 化して multi-client でも扱えるようにする
- app-server への response routing を担う

### 6.2 control surface を 3 層に分ける

高度な制御面は以下の 3 層に分けて設計する。

- thread defaults
  - session / thread の既定値
- turn overrides
  - その turn だけ、または以後の turn に適用される override
- runtime requests
  - 実行中に発生する approval / input / elicitation

この 3 層を混ぜない方が、
UI も backend も整理しやすい。

### 6.3 read-only 表示から始める

v1 で最初に必要なのは、
全部を編集可能にすることではない。

まずは以下を正しく見せるべきである。

- 今どの model で動いているか
- 今どの approval policy / sandbox か
- 今どの reasoning / collaboration で動いているか
- いま解決待ち request があるか

可視化が先にあると、
後続の editable UI を安全に増やせる。

### 6.4 workflow approval と runtime approval を分離する

`Approve and implement` のような workflow 承認は、
execution permission とは別物である。

plan-first を導入しても、
runtime approval は Codex native flow に寄せる。

この分離は維持すべきである。

## 7. 推奨プロダクト仕様

### 7.1 session / thread metadata

session 単位で最低限以下を持つ。

- `controlDefaults`
  - `model`
  - `approvalPolicy`
  - `approvalsReviewer`
  - `sandboxPreset`
  - `reasoningEffort`
  - `reasoningSummary`
  - `personality`
  - `workflowMode`
- `currentCodexState`
  - 現在 thread に有効な設定 snapshot
- `pendingRequest`
  - 先頭 request の概要
- `pendingRequestCount`
  - 未解決 request 数

補足:

- `workflowMode` の詳細は `docs/plan-first-workflow-design.md` に分離する
- approval / sandbox の詳細は `docs/execution-permissions-design.md` に分離する

### 7.2 currentCodexState の扱い

UI 表示用に、
Codex 現在値の read model を持つ。

候補:

- `model`
- `modelProvider`
- `serviceTier`
- `approvalPolicy`
- `approvalsReviewer`
- `sandboxPolicy`
- `reasoningEffort`
- `reasoningSummary`
- `personality`
- `collaborationMode`
- `threadStatus`

これは
session metadata の desired state とは別物として扱う。

### 7.3 pending request queue

bridge には request queue が必要である。

最低限必要な責務:

- requestId と thread / turn / item の紐付け
- 複数 request の FIFO 管理
- response timeout / cancellation
- `serverRequest/resolved` 通知との整合
- reconnect 後の再同期

request 種別は最低限以下。

- command approval
- file change approval
- permissions approval
- request_user_input
- MCP elicitation

### 7.4 settings UI

settings は最低限以下の 2 層で出す。

- session/thread settings
  - 既定の model / approval / sandbox / workflow
- per-run override
  - 今回だけ変える model / reasoning / collaboration

最初から複雑な profile 管理までは要らない。

### 7.5 advanced 面の位置づけ

以下は advanced 面として出すのがよい。

- `danger-full-access`
- granular approval policy
- `guardian_subagent`
- `outputSchema`
- plugin / skill install / read

v1 で front-and-center に置く必要はない。

## 8. API / 型設計の提案

### 8.1 shared types

最低限、以下の型追加が必要。

- current Codex settings snapshot
- model summary
- session control defaults
- pending request summary
- request payload
- request response payload
- live plan update event

request payload は種別ごとに分ける。

- command approval request
- file change approval request
- permissions approval request
- request_user_input request
- MCP elicitation request

### 8.2 WebSocket

WS は以下の push を扱えるようにする。

- `codex.settings.updated`
- `codex.request.created`
- `codex.request.resolved`
- `codex.plan.updated`

client -> server 側にも最低限以下が要る。

- `codex.request.respond`
- `codex.session.subscribe`

現状の `ping` / `session.read` だけでは足りない。

### 8.3 REST

初期ロードや再接続回復用に、
REST でも以下を読む口が要る。

- session current settings
- pending request list
- model list

response 用 API も必要になる。

- pending request への応答

## 9. UI 仕様案

### 9.1 v1 の表示面

まず出すべきは以下。

- current model
- current reasoning effort / summary
- current approval policy / sandbox
- workflow badge
- pending request badge

この段階では、
read-only でも十分価値がある。

### 9.2 pending request 解決 UI

pending request は bottom sheet / modal で扱う。

必要な種別:

- command approval
- file change approval
- additional permission approval
- request_user_input
- MCP elicitation

特に command approval は、
可能なら以下を見せる。

- raw command
- cwd
- parsed command actions
- requested network / filesystem permissions
- session まで拡張する選択肢

### 9.3 settings panel

settings panel では以下を出す。

- model
- reasoning effort
- reasoning summary
- collaboration mode
- approval policy
- sandbox preset

初期段階では、
session default と next run override を
1 枚の sheet に分けて置いてよい。

### 9.4 plan-first との接続

plan-first は別文書で詳細化するが、
この control surface 文脈では以下だけ押さえる。

- workflowMode は thread-level UX
- protocol 反映は `turn/start.collaborationMode`
- `Approve and implement` は new turn

### 9.5 future UI

v2 以降で以下を追加できる。

- `turn/steer`
- `review/start`
- skill / plugin 状態表示
- config requirements 診断

## 10. 実装フェーズ

### Phase 1: 成立条件の回復

最優先:

1. `approvalPolicy` / `sandbox` の固定値を外す
2. bridge で server request を受けて queue 化する
3. request response API を実装する
4. web で pending request dialog を実装する

この phase が、
高度な control surface の成立条件である。

### Phase 2: 可視化

次に以下を入れる。

1. current settings read model
2. `model/list` 取得
3. session detail / header / status menu への表示
4. live plan update relay

### Phase 3: 編集可能化

次に以下を入れる。

1. session default settings
2. per-run override
3. plan-first workflow mode
4. reasoning / collaboration の切り替え

### Phase 4: 拡張 control

最後に以下を検討する。

1. `turn/steer`
2. `review/start`
3. `guardian_subagent`
4. granular approval template
5. skill / plugin 面

## 11. 非目標

少なくとも v1 では以下を非目標とする。

- full IDE parity
- すべての app-server surface の完全露出
- plugin / skill install のフルマネジメント UI
- 複雑な policy profile editor
- multi-user approval workflow

## 12. 最終提案

高度な Codex 制御面は、
以下の順で取り込むのが妥当である。

1. 双方向 protocol 対応
2. current state 可視化
3. settings / override 編集
4. workflow / review / steer 拡張

特に重要なのは、
approval / input を扱えるようにして
Codex native flow を壊さないことである。

現状の
`danger-full-access + never` を前提にした thin bridge から、
runtime request を扱える protocol adapter へ進化させるべきである。

この方針なら、
remote control 製品として必要な制御面を段階的に広げつつ、
Codex app-server の思想と機能を素直に取り込める。

## 13. 参考

- OpenAI Codex App Server
  - https://developers.openai.com/codex/app-server
- OpenAI Codex Agent approvals & security
  - https://developers.openai.com/codex/agent-approvals-security
- OpenAI Codex CLI features
  - https://developers.openai.com/codex/cli/features
- `docs/execution-permissions-design.md`
- `docs/plan-first-workflow-design.md`
