# Codex Mobile Remote Web App 詳細設計書

## 0. ドキュメントの目的

本書は、**家の Mac mini 上で動作する Codex を、スマホや別 PC から安全かつ快適に操作するための Web アプリケーション一式**の詳細設計である。実装担当者が、この文書だけで以下を判断できることを目的とする。

- 何を作るのか
- どのユースケースを優先するのか
- 何が技術的に可能で、何を v1 で採用するのか
- どのアーキテクチャ・技術スタックを採用するのか
- データモデル、API、UI、状態管理、永続化、運用、監視をどう設計するのか
- 実装順序と検証計画をどう組むのか
- どの公式資料を参照すべきか

本設計の対象は、**Codex をスマホから便利に操作できる mobile-first の閉域 Web アプリケーション**であり、公開 SaaS ではない。

---

## 1. エグゼクティブサマリー

### 1.1 作るもの

以下の性質を持つ Web アプリケーションを作る。

- Mac mini 上の Codex を backend として利用する
- Android / iPhone / タブレット / PC のブラウザから操作できる
- Tailscale tailnet 内のみでアクセス可能
- レポジトリ一覧とセッション一覧を持つ
- セッションを継続利用できる
- 長時間実行の完了やエラーに気づける
- スマホ優先 UI だが、折りたたみスマホとタブレットにも対応する

### 1.2 結論

v1 では、**Codex App Server を browser に直接つなぐのではなく、bridge server を 1 枚挟む構成**を採用する。Codex App Server は rich client 用の JSON-RPC ベース基盤であり、stdio が標準 transport、WebSocket は experimental であるため、ブラウザとの境界は独自の bridge で吸収するのが安全かつ保守しやすい。参考:

- https://developers.openai.com/codex/app-server
- https://openai.com/index/unlocking-the-codex-harness/

### 1.3 重要な設計判断

- 公開範囲は **Tailscale tailnet 内のみ**
- bridge が **repo / session / unread / run 状態を独自管理**する
- Codex の内部 thread を UI の唯一の真実として扱わない
- UI は **mobile-first**
- 永続化は **SQLite**
- backend は **Node.js + TypeScript + Fastify**
- frontend は **React + TypeScript + Vite**
- リアルタイム更新は **WebSocket**
- 認証は **feature flag で optional** とし、個人専用 tailnet では無効化可能にする

---

## 2. 背景と前提

### 2.1 背景

Codex は CLI、App、Web、IDE など複数 surface を持ち、App Server はそれらの richer client 連携のための基盤として提供されている。今回必要なのは、Claude Code の remote control 的な体験に近いものを、**自前の Web アプリとして最適化して実現すること**である。

参考:
- CLI docs: https://developers.openai.com/codex/cli
- App Server docs: https://developers.openai.com/codex/app-server
- App Server の設計背景: https://openai.com/index/unlocking-the-codex-harness/

### 2.2 対象ユーザー

主対象は 1 名の個人利用者。将来的に少人数利用へ拡張しやすい構造は意識するが、v1 ではマルチテナントや複雑な権限管理は対象外。

### 2.3 運用前提

- 家に常時起動の Mac mini がある
- Mac mini 上で Codex CLI が動作可能
- 対象レポジトリは Mac mini 上に clone 済み
- 利用者の端末は Tailscale で同一 tailnet に参加する
- Web アプリはパブリックインターネットへ公開しない

### 2.4 非対象

- 不特定多数向け公開サービス
- 外部公開ドメイン + public reverse proxy 前提の設計
- Codex App Server の raw protocol をそのままブラウザに露出する設計
- 公開 API 商品化
- 高度な collaborative editing

---

## 3. 要件整理

## 3.1 機能要件

### 必須

1. レポジトリ一覧を取得して切り替えできること
2. セッション一覧を取得して切り替えできること
3. セッションを新規作成できること
4. セッションごとに Codex へ指示を送れること
5. 実行中のイベントをストリーム表示できること
6. 長時間実行の完了・エラーに気づけること
7. セッションの未読バッジがあること
8. セッションを文字検索できること
9. スマホ優先 UI で使いやすいこと
10. 折りたたみスマホ・タブレットにも対応すること
11. Tailscale tailnet 内のみで利用できること

### あると良いが v1 では限定実装

1. セッションタイトル自動生成
2. セッション要約
3. 実行中 run の interrupt
4. タブタイトルによる未読通知
5. PWA installability

### 後回し

1. OS レベル push 通知
2. 複数ユーザー間の閲覧権限
3. diff viewer の高度化
4. file upload / attachment
5. Codex との双方向高度同期
6. offline support

## 3.2 非機能要件

### セキュリティ
- tailnet 内限定アクセス
- optional auth
- 任意のローカルパス操作をクライアントに開放しない
- 任意 shell をそのまま叩ける API を公開しない

### 保守性
- Codex protocol 変更に耐えやすい adapter 層を持つ
- UI 用状態と Codex internal state を分離する

### 可観測性
- health endpoint
- structured logs
- child process restart count
- active sessions count

### UX
- 片手操作しやすい
- 実行中か完了したかがひと目で分かる
- session list の情報密度が高い

---

## 4. 技術的に可能なもの / 採用するもの / 採用しないもの

## 4.1 十分に可能で v1 で採用するもの

- Tailscale tailnet 内のみの Web 公開
- mobile-first browser UI
- repository list
- session list
- session unread badge
- run 完了検知
- session search
- SQLite 永続化
- browser と bridge 間の WebSocket ストリーム
- bridge と Codex App Server 間の stdio JSON-RPC

## 4.2 可能だが v1 では限定採用

- 認証なし運用
  - 個人専用 tailnet なら現実的
  - 設計としては optional auth module を残す
- Web Notification API
  - ブラウザ許可を前提にすれば可能
  - v1 ではタブタイトル更新を優先
- PWA
  - installable にはできる
  - offline や push までは v1 で追わない

## 4.3 技術的に可能だが v1 で採用しないもの

- Codex App Server の WebSocket transport を browser から直接使うこと
- Codex internal session list に強く依存した UI
- tailnet 外公開
- 複雑な multi-user ACL

## 4.4 厳しい / 避けるべきもの

- app-server を public internet にそのまま出す
- browser から任意 path / 任意 shell command を直接送る設計
- Codex 生イベントをすべて UI に垂れ流す設計

---

## 5. 参照技術と採用スタック

## 5.1 採用技術

### Backend
- Node.js 20+
- TypeScript
- Fastify
- `ws` もしくは Fastify WebSocket 対応
- SQLite
- better-sqlite3
- Zod
- pino

### Frontend
- React 19 系
- TypeScript
- Vite
- TanStack Query
- Zustand または Redux Toolkit の軽量利用
- React Router
- CSS は Tailwind CSS を推奨

### Infra / Runtime
- macOS on Mac mini
- Codex CLI
- Codex App Server
- Tailscale
- launchd または pm2

## 5.2 採用理由

### React + Vite
- モバイル優先 UI を素早く組みやすい
- 開発体験が軽い
- PWA 化もしやすい

参考:
- React: https://react.dev/learn
- Vite: https://vite.dev/guide/
- TypeScript: https://www.typescriptlang.org/docs/
- PWA: https://web.dev/learn/pwa/

### Fastify
- Node 上で軽量かつ高速
- plugin 構造が明確
- TypeScript 相性が良い

参考:
- https://fastify.dev/docs/latest/Reference/Server/

### SQLite + better-sqlite3
- 単一ユーザー・単一ホストに適している
- セッション・メッセージ・検索・未読管理に十分
- 運用コストが低い

参考:
- better-sqlite3 API: https://github.com/WiseLibs/better-sqlite3

### WebSocket
- run 中のストリームをブラウザへ即時反映するのに適している
- unread badge 更新や status 更新にも使える

参考:
- Socket.IO docs: https://socket.io/docs/v4/
  - ただし v1 ではまず素の WebSocket を優先し、必要なら Socket.IO に切替可能な設計にする

### Tailscale
- tailnet 内限定公開が容易
- MagicDNS で名前解決しやすい
- Serve でローカル Web を共有できる

参考:
- MagicDNS: https://tailscale.com/docs/features/magicdns
- Tailscale Serve: https://tailscale.com/docs/features/tailscale-serve
- serve CLI: https://tailscale.com/docs/reference/tailscale-cli/serve

### Codex App Server
- rich client 用の公式接続面である
- browser から直接ではなく、bridge から stdio で使う

参考:
- https://developers.openai.com/codex/app-server
- https://openai.com/index/unlocking-the-codex-harness/

---

## 6. システム全体像

## 6.1 全体アーキテクチャ

```text
[Phone / Tablet / PC Browser]
          |
     HTTPS over Tailscale
          |
   [Tailscale Serve]
          |
   [Bridge Server]
      |         \
      |          \__ [SQLite]
      |
      | stdio JSON-RPC
      |
 [codex app-server]
      |
 [local repo / git / shell context]
```

## 6.2 コンポーネント一覧

1. Web Frontend
2. Bridge Server
3. Codex Process Manager
4. SQLite Persistence
5. Tailscale Exposure Layer
6. Host Runtime Manager

## 6.3 設計原則

- Codex raw protocol は backend 内で閉じる
- UI は backend が正規化したモデルだけを見る
- repo と session は UI の最上位概念とする
- run と message を分離する
- unread は event sequence に基づいて計算する
- すべての機能は mobile-first で設計する

---

## 7. アプリケーション構造

## 7.1 推奨 monorepo 構成

```text
codex-mobile-remote/
  apps/
    bridge/
      src/
        app.ts
        main.ts
        config/
        plugins/
        auth/
        codex/
        repos/
        sessions/
        messages/
        runs/
        realtime/
        db/
        observability/
      package.json
      tsconfig.json
    web/
      src/
        main.tsx
        app/
        pages/
        components/
        features/
          repos/
          sessions/
          chat/
          notifications/
        hooks/
        api/
        store/
        styles/
      package.json
      tsconfig.json
  packages/
    shared-types/
    shared-schema/
  docs/
    design.md
    api.md
    runbook.md
  scripts/
  package.json
```

## 7.2 モジュール責務

### bridge/codex
- `codex app-server` の起動・監視
- JSON-RPC request/response 管理
- raw event の正規化

### bridge/repos
- repo 一覧
- active repo state
- repo whitelist

### bridge/sessions
- session 作成、検索、一覧、アーカイブ
- unread 管理

### bridge/messages
- user / assistant message 永続化

### bridge/runs
- run 状態
- run interrupt
- run completion state

### bridge/realtime
- browser への WebSocket 配信
- session ごとの event fan-out

---

## 8. データモデル

## 8.1 Repository

```ts
Repository = {
  id: string;
  name: string;
  path: string;
  description?: string;
  branch?: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}
```

### 説明
- `path` はサーバー側ホワイトリスト設定のみ
- クライアントから任意 path を受け取らない

## 8.2 Session

```ts
Session = {
  id: string;
  repoId: string;
  title: string;
  summary: string;
  codexThreadId?: string;
  status: 'idle' | 'running' | 'completed' | 'error' | 'archived';
  unreadCount: number;
  lastEventSeq: number;
  lastReadEventSeq: number;
  lastMessageAt: string;
  lastRunFinishedAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 説明
- UI 上の Session と Codex thread は 1:1 固定にしない
- `codexThreadId` は任意。将来の protocol 変化にも耐えるため UI レコードを主にする

## 8.3 Message

```ts
Message = {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: string;
}
```

## 8.4 Run

```ts
Run = {
  id: string;
  sessionId: string;
  status: 'queued' | 'running' | 'completed' | 'interrupted' | 'error';
  startedAt: string;
  finishedAt?: string;
  errorMessage?: string;
}
```

## 8.5 EventLog

```ts
EventLog = {
  seq: number;
  sessionId: string;
  kind: string;
  payloadJson: string;
  createdAt: string;
}
```

### 用途
- unread 計算
- 後から軽いデバッグ
- session list の更新トリガー

## 8.6 NotificationState

```ts
NotificationState = {
  sessionId: string;
  hasUnreadCompletion: boolean;
  hasUnreadError: boolean;
}
```

---

## 9. 永続化設計

## 9.1 DB 選定

v1 は SQLite を採用する。理由は以下。

- 単一ホスト運用
- トランザクションが十分強い
- セットアップが簡単
- 検索要件に十分対応できる

## 9.2 推奨テーブル

- repositories
- sessions
- messages
- runs
- event_logs
- app_state

## 9.3 検索戦略

### v1
- title
- summary
- latest user prompt
- latest assistant excerpt

の metadata ベース検索を行う。SQL の `LIKE` で開始してよい。

### v1.5 以降
- SQLite FTS5 による全文検索へ移行可能な schema にする

## 9.4 unread 算出

- session ごとに `lastEventSeq` を持つ
- session を開いたタイミングで `lastReadEventSeq = lastEventSeq`
- unread は `max(0, lastEventSeq - lastReadEventSeq)`

ただし token delta のような細粒度イベントは unread 対象にしない。以下のみ unread 対象とする。

- assistant final message
- run completed
- run error
- tool completed

---

## 10. Codex 連携設計

## 10.1 接続方式

bridge は `codex app-server` を **子プロセスとして起動**し、stdio で JSON-RPC 2.0 をやり取りする。

参考:
- https://developers.openai.com/codex/app-server
- https://openai.com/index/unlocking-the-codex-harness/

## 10.2 採用理由

- stdio が標準 transport
- browser に raw app-server を公開しなくて済む
- protocol adapter を bridge 内に閉じ込められる

## 10.3 process strategy

### v1 推奨
- bridge 起動時に codex app-server を 1 プロセス起動
- repo / session コンテキストは bridge 側で管理
- run 実行時に対象 repo を明示して Codex に渡す

### 将来の余地
- repo ごとに process pool を分ける
- worktree ごとの isolation

## 10.4 protocol adapter の責務

- JSON-RPC id 管理
- request timeout
- response correlation
- event dispatch
- malformed output handling
- stdout / stderr ログ分離

## 10.5 event normalization

Codex raw event をそのまま UI に流さず、以下の UI event に変換する。

```ts
UiEvent =
  | { kind: 'status'; value: 'idle' | 'running' | 'completed' | 'error' }
  | { kind: 'message.delta'; text: string }
  | { kind: 'message.final'; text: string }
  | { kind: 'tool.start'; name: string }
  | { kind: 'tool.end'; name: string; ok: boolean }
  | { kind: 'run.completed' }
  | { kind: 'run.error'; message: string }
```

### 重要
- session list 向け lightweight state 更新と
- chat 詳細向け stream 表示

を分離して扱う。

---

## 11. Repository 管理設計

## 11.1 repo source of truth

bridge の設定ファイルまたは DB が正とする。

### 初期設定例

```json
[
  {
    "id": "repo_main",
    "name": "main-repo",
    "path": "/Users/you/work/main-repo",
    "description": "Primary working repository",
    "pinned": true
  }
]
```

## 11.2 API

- `GET /api/repos`
- `GET /api/repos/:repoId`
- `POST /api/repos/:repoId/select`

## 11.3 UI 要件

repo list には以下を表示する。

- name
- current branch
- pinned
- running session count
- updatedAt

### branch 取得
- 初期は lazy fetch でよい
- repo list を毎秒更新しない

---

## 12. Session 管理設計

## 12.1 session source of truth

bridge DB を正とする。

## 12.2 session lifecycle

1. create
2. idle
3. running
4. completed / error
5. reopened
6. archived

## 12.3 session title

### 初期
- 初回ユーザープロンプトから簡易生成
- 長すぎる場合は truncate

### 将来
- Codex 要約でタイトル再生成

## 12.4 API

- `GET /api/sessions?repoId=...`
- `GET /api/sessions/:sessionId`
- `POST /api/sessions`
- `POST /api/sessions/:sessionId/select`
- `POST /api/sessions/:sessionId/archive`
- `POST /api/sessions/:sessionId/read`
- `GET /api/sessions/search?q=...&repoId=...`

## 12.5 一覧ソート

デフォルトは以下順。

1. running
2. unread completion / error
3. updatedAt desc

これにより、長期セッションが終わったときに気づきやすくする。

---

## 13. Run 管理設計

## 13.1 run は session と別エンティティにする理由

- 実行履歴を管理しやすい
- running / completed / interrupted を独立追跡できる
- session 自体の存在と run の存在を混同しない

## 13.2 API

- `POST /api/runs`
- `POST /api/runs/:runId/interrupt`
- `GET /api/runs/:runId`

### 実際の client UX
- chat 画面では session 内から run start するが、backend では run entity を作る

## 13.3 同時実行制限

### v1
- 1 session あたり 1 active run
- 全体の同時 active run 数は 1〜2 に制限

理由:
- Mac mini リソース管理
- UI 複雑化回避
- Codex process 管理の単純化

---

## 14. リアルタイム通信設計

## 14.1 browser ↔ bridge

WebSocket を採用する。

### 理由
- stream 表示
- unread badge 更新
- run completion 即時反映
- session list の軽量更新

## 14.2 接続方式

- `GET /ws`
- cookie または session token を利用
- auth disabled 時も server-generated client session は保持する

## 14.3 client → server event

- `repo.select`
- `session.create`
- `session.select`
- `session.read`
- `run.start`
- `run.interrupt`
- `ping`

## 14.4 server → client event

- `repos.updated`
- `sessions.updated`
- `session.updated`
- `run.started`
- `run.completed`
- `run.error`
- `message.delta`
- `message.final`
- `notification.unread`
- `pong`

## 14.5 reconnect 戦略

- exponential backoff
- reconnect 後に selected repo / session を再取得
- missed event 補完は REST refetch で解決

---

## 15. API 詳細

## 15.1 HTTP API

### `GET /healthz`

```json
{ "ok": true }
```

### `GET /api/repos`

```json
{
  "repos": [
    {
      "id": "repo_main",
      "name": "main-repo",
      "branch": "main",
      "pinned": true,
      "runningSessionCount": 1,
      "updatedAt": "2026-03-28T20:00:00Z"
    }
  ]
}
```

### `GET /api/sessions?repoId=repo_main`

```json
{
  "sessions": [
    {
      "id": "sess_1",
      "title": "Fix failing tests",
      "summary": "Working on test failures in API module",
      "status": "running",
      "unreadCount": 0,
      "updatedAt": "2026-03-28T20:05:00Z"
    }
  ]
}
```

### `GET /api/sessions/search?q=test&repoId=repo_main`

```json
{
  "sessions": [
    {
      "id": "sess_1",
      "title": "Fix failing tests",
      "summary": "Working on test failures in API module",
      "status": "running",
      "unreadCount": 0,
      "updatedAt": "2026-03-28T20:05:00Z"
    }
  ]
}
```

### `POST /api/sessions`

```json
{
  "repoId": "repo_main",
  "title": "Optional title"
}
```

Response:

```json
{
  "session": {
    "id": "sess_2",
    "repoId": "repo_main",
    "status": "idle"
  }
}
```

### `GET /api/sessions/:sessionId/messages`

```json
{
  "messages": [
    {
      "id": "msg_1",
      "role": "user",
      "text": "Fix the tests",
      "createdAt": "..."
    }
  ]
}
```

### `POST /api/sessions/:sessionId/read`

```json
{ "ok": true }
```

### `POST /api/runs`

```json
{
  "sessionId": "sess_2",
  "prompt": "Investigate and fix the failing tests."
}
```

Response:

```json
{
  "run": {
    "id": "run_1",
    "status": "running"
  }
}
```

### `POST /api/runs/:runId/interrupt`

```json
{ "ok": true }
```

## 15.2 Optional auth API

### `POST /api/auth/login`

```json
{ "passphrase": "..." }
```

Response:

```json
{ "ok": true }
```

Auth disabled 時は endpoint 自体を no-op にするか、ビルドフラグで除外する。

---

## 16. UI / UX 設計

## 16.1 UI 原則

- mobile-first
- 高頻度操作を親指圏内に置く
- 長時間 run の完了検知を重視
- 情報量は多いが、見せ方は段階的にする

## 16.2 画面構成

### Desktop / Tablet Large

3 カラム:

```text
[Repos] [Sessions] [Chat / Run Detail]
```

### Foldable / Small Tablet

2 カラム:

```text
[Sessions] [Chat]
```

repo switcher は上部 dropdown / drawer。

### Phone

1 カラム + segmented navigation:

```text
[Repos] [Sessions] [Chat]
```

画面上部または下部に segmented control を置く。

## 16.3 主要 UI コンポーネント

### Repos Pane
- repo list
- current branch
- running count
- pin marker

### Sessions Pane
- search input
- filter chips: all / running / unread / completed / error
- session rows
  - title
  - summary 1行
  - updated time
  - status icon
  - unread badge

### Chat Pane
- session header
- message timeline
- run status banner
- prompt input
- send button
- interrupt button

### Global indicators
- network state
- codex backend health
- pending reconnection banner

## 16.4 状態表示ルール

### session row
- `running`: animated dot
- `completed with unread`: green badge
- `error with unread`: red badge
- `idle`: neutral

### tab title
- unread completion or error がある場合 `(N) Codex Remote`

## 16.5 通知戦略

### v1
- unread badge
- status icon
- tab title update

### v1.5 optional
- Notifications API を許可時のみ利用

参考:
- Notifications API: https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API

---

## 17. レスポンシブ・デバイス対応設計

## 17.1 ブレークポイント

- `sm`: < 600px
- `md`: 600px - 899px
- `lg`: >= 900px

## 17.2 デバイス別振る舞い

### Phone
- single panel
- full-screen list view
- bottom-fixed input
- session list から chat へ遷移

### Foldable
- dual pane を優先
- hinge-aware optimization は nice-to-have
- セッション一覧と chat を同時表示

### Tablet
- 2〜3 カラム
- repos pane の常時表示も可

## 17.3 実装方針

- CSS Grid
- container queries を使えるなら採用
- safe-area insets 対応
- mobile viewport height 問題へ対応

---

## 18. 認証・セキュリティ設計

## 18.1 ネットワーク境界

- bridge は `127.0.0.1` bind
- 公開は Tailscale Serve 経由のみ
- public internet exposure は対象外

参考:
- https://tailscale.com/docs/features/tailscale-serve
- https://tailscale.com/docs/reference/tailscale-cli/serve

## 18.2 auth policy

### デフォルト方針
- 個人専用 tailnet なら auth disabled 可
- feature flag で切り替えられる実装にする

### optional auth 実装
- shared passphrase
- signed cookie session
- WebSocket handshake でも検証

## 18.3 input constraints

- prompt max length 制限
- repo path は server fixed
- shell command API 不提供
- run concurrency 制限

## 18.4 log sanitization

- credentials をログに出さない
- prompt 全文ログは設定で抑制可能

---

## 19. Tailscale 設計

## 19.1 採用機能

- Tailscale node on Mac mini
- MagicDNS
- Tailscale Serve

参考:
- MagicDNS: https://tailscale.com/docs/features/magicdns
- Serve: https://tailscale.com/docs/features/tailscale-serve
- serve CLI: https://tailscale.com/docs/reference/tailscale-cli/serve

## 19.2 公開方式

bridge が `127.0.0.1:3000` で待ち受ける。

例:

```bash
tailscale serve 3000
```

アクセス先は MagicDNS 名を利用する。

例:

```text
https://mac-mini.<tailnet>.ts.net
```

### 注意
- 実際の hostname / URL は tailnet 設定に従う
- 実装者は Tailscale docs に沿って確認すること

## 19.3 なぜ Funnel を使わないか

- v1 は閉域利用が目的
- public ingress は不要
- セキュリティ面の複雑性を増やさない

---

## 20. 可観測性・運用設計

## 20.1 logging

- backend: pino JSON logs
- categories:
  - app startup
  - codex child spawn
  - rpc request/response
  - session lifecycle
  - run lifecycle
  - websocket connect/disconnect
  - db error

## 20.2 health

### `GET /healthz`
返すべき情報:
- app ok
- db ok
- codex child alive
- tailscale exposure は参考情報のみ

## 20.3 metrics

最低限の内部 metrics:
- active websocket connections
- active runs
- codex child restarts
- average run duration
- unread completion count

## 20.4 process supervision

推奨:
- `launchd` または `pm2`

Mac mini では `launchd` が自然だが、開発・試験中は `pm2` でもよい。

---

## 21. 実装詳細

## 21.1 Backend 内部クラス

### `CodexProcessManager`
責務:
- child process spawn
- ready wait
- stdout parser
- restart with backoff
- graceful shutdown

### `CodexRpcClient`
責務:
- JSON-RPC request id 発番
- timeout
- promise resolution
- event callback routing

### `EventNormalizer`
責務:
- raw Codex events を UI events に変換
- unread 対象イベントのみ別分類

### `RepositoryService`
責務:
- repo list
- repo metadata
- branch resolve

### `SessionService`
責務:
- create/list/select/archive/search
- read state update
- title/summary update

### `RunService`
責務:
- run start
- interrupt
- status transition
- finalization

### `RealtimeGateway`
責務:
- ws connect/disconnect
- subscribe selected session
- push session list deltas
- push message stream

## 21.2 Frontend state design

### server state
- repos list
- sessions list
- messages list
- run details

TanStack Query で保持。

### client state
- selected repo id
- selected session id
- ws connection state
- draft prompt
- responsive layout mode

Zustand で保持。

## 21.3 data fetching 方針

- 初期表示: repos, sessions を fetch
- session selection 時: messages fetch
- ws イベント到達時: query cache patch または invalidate

---

## 22. エラーハンドリング設計

## 22.1 想定エラー

- Codex CLI 未インストール
- Codex 未ログイン
- app-server 起動失敗
- repo path 不存在
- SQLite lock / corruption
- ws disconnect
- Tailscale 経由で到達不可
- run の多重開始

## 22.2 UI 表示方針

- ユーザー向け短文
- 詳細は expandable
- recover action を添える

例:
- 「Codex backend に接続できません」
- 「現在このセッションは実行中です」
- 「接続が切れました。再接続しています」

## 22.3 fallback

- ws 切断時は REST poll で最低限の状態復元
- child crash 時は auto restart 1〜3 回、その後 degraded mode

---

## 23. 実装順序

## Phase 1: 基盤

1. monorepo 作成
2. bridge skeleton
3. frontend skeleton
4. SQLite schema
5. repo config load
6. health endpoint

## Phase 2: Codex 接続

1. child spawn
2. JSON-RPC transport
3. simple run start
4. raw stream logging
5. normalized event mapping

## Phase 3: 基本 UI

1. repo list
2. session list
3. session create
4. chat detail
5. prompt submit
6. run status

## Phase 4: session 管理強化

1. unread badge
2. session search
3. read state update
4. completed/error highlighting
5. tab title update

## Phase 5: mobile UX

1. responsive layouts
2. foldable / tablet tuning
3. bottom input polish
4. reconnect UX

## Phase 6:運用

1. launchd/pm2
2. Tailscale Serve
3. runbook
4. logs / backup

---

## 24. テスト計画

## 24.1 Unit Test

- rpc request/response mapping
- event normalization
- unread count update
- session search query builder
- state transitions

## 24.2 Integration Test

- codex child spawn
- run start → stream → complete
- run interrupt
- session list refresh
- ws reconnect
- sqlite persistence restore

## 24.3 Manual Test

### Phone
- repo 切替
- session 作成
- run 開始
- completion badge 表示
- reconnect 復帰

### Foldable / Tablet
- 2カラム / 3カラム表示
- search usage
- session switching

### Desktop
- 複数セッション観察
- 長文 stream 表示

---

## 25. 実装者向け明確な禁止事項

1. `codex app-server` を browser に直接公開しないこと
2. public internet に exposed しないこと
3. client から任意の filesystem path を受け取らないこと
4. arbitrary shell API を提供しないこと
5. unread を token delta ベースで数えないこと
6. Codex internal session list を唯一の source of truth にしないこと

---

## 26. 参考 URL 一覧

### Codex / OpenAI
- Codex App Server: https://developers.openai.com/codex/app-server
- Codex CLI: https://developers.openai.com/codex/cli
- Unlocking the Codex harness: https://openai.com/index/unlocking-the-codex-harness/

### Tailscale
- MagicDNS: https://tailscale.com/docs/features/magicdns
- Tailscale Serve: https://tailscale.com/docs/features/tailscale-serve
- serve CLI: https://tailscale.com/docs/reference/tailscale-cli/serve
- Site-to-site / networking concepts: https://tailscale.com/docs/features/site-to-site

### Frontend / Backend
- React: https://react.dev/learn
- Vite: https://vite.dev/guide/
- TypeScript: https://www.typescriptlang.org/docs/
- Fastify: https://fastify.dev/docs/latest/Reference/Server/
- Socket.IO reference: https://socket.io/docs/v4/
- PWA fundamentals: https://web.dev/learn/pwa/
- Notifications API: https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API
- better-sqlite3 repository: https://github.com/WiseLibs/better-sqlite3

---

## 27. 最終判断

このアプリケーションは、**技術的に十分実現可能**であり、最初にやるべき構成は明確である。

- Codex は backend
- bridge が境界面
- Tailscale が閉域アクセス基盤
- SQLite が UI 用の真実を保持
- React ベースの mobile-first UI で repo / session / chat を操作する

重要なのは、**Codex の raw protocol をそのまま UI に背負わせないこと**、そして **repo / session / unread / run 完了というユーザー体験に必要な概念を bridge 側で再構成すること**である。

この方針なら、スマホから実用になる。逆にここを雑にすると、ただの不安定な遠隔端末になる。

