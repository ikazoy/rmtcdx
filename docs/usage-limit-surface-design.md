# Usage Limit Surface Design

## 1. 目的

本書は、Codex Remote Web Client における `usage limit` 表示の設計を定義する。
対象は以下の 2 系統である。

- アカウント / ワークスペース全体の usage limit
- スレッド / turn 単位の token usage

本書の目的は、protocol 上で取得できる情報、bridge が吸収すべき責務、
desktop / mobile それぞれで自然な表示位置、表示ルール、v1 の実装境界を
明確にすることである。

## 2. 前提

- 対象 runtime は Codex app-server 経由の real mode
- 対象確認バージョンは `codex-cli 0.116.0`
- 本設計は app-server schema generation と、`initialize` 後に
  `account/rateLimits/read` を実行したローカル probe に基づく
- これらの surface は raw event ではなく、standard request /
  notification として protocol に含まれる

## 3. Protocol で取得できるもの

### 3.1 アカウント全体の usage limit

app-server は以下を提供する。

- request: `account/rateLimits/read`
- notification: `account/rateLimits/updated`

取得できる情報は概ね以下。

- `rateLimits`
  - 後方互換の単一 bucket view
- `rateLimitsByLimitId`
  - `codex` などの `limit_id` 単位の multi-bucket view
- bucket ごとの情報
  - `limitId`
  - `limitName`
  - `primary.usedPercent`
  - `primary.windowDurationMins`
  - `primary.resetsAt`
  - `secondary.usedPercent`
  - `secondary.windowDurationMins`
  - `secondary.resetsAt`
  - `credits.hasCredits`
  - `credits.unlimited`
  - `credits.balance`
  - `planType`

補足:

- `resetsAt` は Unix 秒
- compact な常設表示には `rateLimitsByLimitId.codex ?? rateLimits` を使う
- model 別 bucket は詳細表示へ回す

### 3.2 スレッド / turn 単位の token usage

app-server は以下を提供する。

- notification: `thread/tokenUsage/updated`

取得できる情報は概ね以下。

- `threadId`
- `turnId`
- `tokenUsage.total`
  - `totalTokens`
  - `inputTokens`
  - `cachedInputTokens`
  - `outputTokens`
  - `reasoningOutputTokens`
- `tokenUsage.last`
  - 直近更新差分の breakdown
- `tokenUsage.modelContextWindow`

### 3.3 usage limit 超過

turn failure 時の error surface では、`codexErrorInfo` に
`usageLimitExceeded` が入りうる。

このため UI 上は以下を区別できる。

- usage が高いがまだ使える
- usage limit を実際に超過した

## 4. 現状実装との差分

現状の bridge は、message / activity / tool / run 系の通知のみを
吸収しており、usage limit 系 surface は relay していない。

具体的には `apps/bridge/src/codex/real-client.ts` の通知ハンドリングは
以下に集中している。

- `item/agentMessage/delta`
- `item/commandExecution/outputDelta`
- `item/started`
- `item/completed`
- `turn/completed`
- `error`

したがって v1 の usage limit surface 実装では、bridge 側に
protocol adapter を追加する必要がある。

## 5. プロダクト判断

### 5.1 global usage と thread token usage を分離する

この 2 つは意味が違うため、同じ場所に混在させない。

- account usage limit は global state
- thread token usage は session-local / run-local state

### 5.2 global usage は session row に出さない

account usage limit は thread ごとの情報ではないため、session list 内の
各 row に繰り返し出すと意味が薄くノイズになる。

### 5.3 composer 近傍を常設表示の主戦場にしない

usage limit は送信ボタン直近に置くと「この prompt 専用の制約」に見えやすい。
実際には account 全体の制約なので、情報設計上は navigation / header 側に置く。

### 5.4 cached snapshot だけでは送信を hard block しない

usage snapshot は更新遅延しうるため、`usedPercent >= 100` だけを根拠に
composer を hard disable しない。制御は以下の優先順位で扱う。

- 事前: warning 表示
- 実際に `usageLimitExceeded` が来たら error banner 表示

## 6. UI 配置方針

## 6.1 account usage limit

### Desktop

常設 summary の自然な置き場は sidebar header である。

- 置き場:
  - `Threads` header 右上の actions 付近
  - または header subtitle 直下の summary row
- 理由:
  - global information として文脈が正しい
  - session 切り替えに依存しない
  - desktop では sidebar が常時見えている

### Mobile

mobile では chat 表示中に sidebar が隠れるため、sidebar のみ配置では
情報が消える。したがって chat header に mirror 表示する。

- 置き場:
  - thread title の直下
  - `Updated ... · repoName` 行の次の行
- 理由:
  - chat 中も視認できる
  - header 情報の延長として違和感が少ない
  - composer よりも global state として自然

### 詳細表示

summary をタップすると詳細を開く。

- mobile:
  - bottom sheet
- desktop:
  - small popover ではなく、やや大きめの dialog / sheet を優先

理由:

- 5h / 7d window
- credits
- model 別 bucket

を出すと、popover では窮屈になりやすいため。

## 6.2 thread token usage

thread token usage は chat pane 専用表示とする。

- 置き場:
  - chat header 直下
  - または activity tray の直前
- 表示対象:
  - active run 中を優先
  - run 完了後は詳細表示へ退避し、常設 header からは外してよい

理由:

- session-local な情報である
- sidebar に置くと文脈がずれる
- 実行中にだけ価値が高い

## 7. 表示ルール

### 7.1 compact summary

account usage の compact summary は 1 行で表示する。

推奨表記:

- `5h 5% · 7d 16%`

補足:

- `primary` を短い window、`secondary` を長い window として扱う
- どちらか片方しかない場合は存在する方のみ表示
- `credits.balance` は compact summary には出さない
- `limitName` も compact summary には出さない

### 7.2 warning / danger

state は以下の 3 段階を持つ。

- normal
  - 両 window とも 80% 未満
- warning
  - どちらかが 80% 以上
- danger
  - どちらかが 95% 以上
  - または `usageLimitExceeded` 発生済み

### 7.3 error 表示

`usageLimitExceeded` が来た場合は、summary 色変更だけでは弱いので、
chat area に banner を出す。

banner 要件:

- 明示的に limit 超過と分かること
- 次の reset time を出せること
- global issue であることが分かること

## 8. Bridge / API 設計

## 8.1 adapter 責務

bridge は protocol の生 surface を UI 向けに正規化する。

必要な責務:

- `account/rateLimits/read` の初期取得
- `account/rateLimits/updated` の購読
- `thread/tokenUsage/updated` の購読
- `resetsAt` を ISO string へ変換
- `threadId` / `turnId` を既存の `sessionId` / `runId` にひも付ける

## 8.2 共有型

`packages/shared-types` には少なくとも以下を追加する。

- `UsageLimitWindow`
- `UsageLimitBucket`
- `AccountUsageLimits`
- `ThreadTokenUsage`

設計原則:

- protocol shape をできるだけ保つ
- ただし timestamp は frontend 一貫性のため ISO string に寄せる

## 8.3 REST / WebSocket

初期ロードとリアルタイム更新を分離する。

### REST

- `GET /api/account/rate-limits`

用途:

- 初期表示
- reconnect 後の再同期
- query cache の seed

### WebSocket

- `account.rate_limits.updated`
- `thread.token_usage.updated`

用途:

- summary の即時更新
- active run 中 token usage の追従

## 8.4 永続化方針

v1 では DB 永続化しない。

- account usage limit:
  - process memory cache
- thread token usage:
  - process memory cache
  - active run の live state として扱う

理由:

- rate limit は時間依存で古くなりやすい
- thread token usage は live telemetry としての価値が高い
- DB へ落とす必然性は v1 では弱い

将来、run summary として token usage を残したくなった場合のみ
`runs` テーブル拡張を検討する。

## 9. 実装順序

### Phase 1: bridge / shared types

- protocol adapter 追加
- REST / WS surface 追加
- React Query / Zustand state 追加

### Phase 2: account usage summary

- desktop sidebar header に compact chip
- mobile chat header に mirror chip
- detail sheet / dialog

### Phase 3: thread token usage

- active run 中の live token usage 表示
- run error と `usageLimitExceeded` banner

## 10. 非採用

v1 では以下を採用しない。

- session row ごとの usage 表示
- composer 直上の常設 usage 表示
- cached snapshot のみを根拠にした送信 disable
- 全 model bucket の常設一覧表示
- token usage の DB 永続化

## 11. 実装メモ

既存 UI への差し込み先は以下が自然である。

- desktop global usage:
  - `apps/web/src/features/sidebar/SidebarPane.tsx`
- mobile global usage:
  - `apps/web/src/features/chat/ChatPane.tsx`
- protocol adapter:
  - `apps/bridge/src/codex/real-client.ts`

この設計により、usage limit は

- global なものは global に
- thread-local なものは chat に

という情報設計が守られ、mobile / desktop のどちらでも違和感なく
扱える。
