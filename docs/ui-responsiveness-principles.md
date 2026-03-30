# UI Responsiveness and View-State Principles

## 1. 目的

本メモは、Codex Remote Web Client における
状態管理と UI 描画の共通方針を定義する。

今回の新規スレッド送信まわりの不具合で分かったのは、
個別の loading 条件をその場で足しても、
データの lifecycle と UI の対応が曖昧なままだと
「一瞬だけどの state にも属さない画面」が発生するということだった。

以後は、

- どの state が canonical か
- entity がどう遷移するか
- 各画面が何を根拠に描画するか

を明示して実装する。

## 2. 状態のレイヤ分離

UI で扱う state は、まず以下の 4 層に分ける。

### 2.1 Routing / Product State

URL や画面サイズ、ユーザーの明示的な選択から決まる state。

例:

- 選択中 session ID
- 現在の画面が一覧か詳細か
- モバイルか desktop か

原則:

- 1 つの事実は 1 つの source of truth だけが持つ
- session 選択の canonical state は route に置く
- route から導出できる state を Zustand に重複保持しない

### 2.2 Server Entity State

バックエンド由来の永続 entity とその取得状態。

例:

- session list
- session detail
- messages
- latest run / active run

原則:

- server data は React Query cache を canonical とする
- list と detail で別々に local copy を持たない
- eventual consistency のための invalidate は許容するが、
  optimistic UI の source of truth と競合させない

### 2.3 Derived View State

query の生 flag を UI に直接見せず、
画面ごとの描画状態に変換したもの。

例:

- `loading`
- `ready`
- `empty`
- `error`
- `refreshing`

原則:

- component は `isLoading && !data && !error` のような bool の組み合わせで描画しない
- 画面ごとに adapter を置き、view state に一度畳む
- UI component は可能な限り `kind` を見て描画する

### 2.4 Ephemeral UI State

描画補助や操作中だけ意味を持つ短命 state。

例:

- composer input
- 添付画像 preview
- actions menu の open/close
- sidebar width
- dev-only debug logs

原則:

- entity の意味を持つものを ephemeral state に押し込まない
- network handoff をまたぐ state は ephemeral に閉じ込めない

## 3. 設計原則

### 3.1 Blank State を作らない

画面は必ず、以下のどれかに属していなければならない。

- loading
- ready
- empty
- error
- transitional ready

「dark background だけが見える」
「empty-state が一瞬だけ出る」
状態は設計漏れとみなす。

### 3.2 Initial Load と Background Refresh を分離する

初回ロードと再取得中は別物として扱う。

- 初回ロード
  - skeleton / placeholder を出してよい
- background refresh
  - 既存内容を残す
  - 必要なら軽い refresh indicator だけを出す

再取得中に既存 UI を消してはならない。

### 3.3 Temporary Entity を正式な entity として扱う

新規スレッド作成や optimistic send の途中状態は、
「まだ本物ではないから特別扱いする」のではなく、
UI 上は正式な entity として扱う。

最低限必要なのは以下。

- temporary session summary
- temporary session detail
- optimistic user message
- pending response state

同じ temporary entity を
一覧と詳細の両方で共有して描画する。

### 3.4 Entity Lifecycle を明示する

特に新規スレッドは lifecycle を暗黙にしない。

推奨遷移:

1. `draft`
2. `pending`
3. `hydrating`
4. `ready`
5. `error`

補足:

- `draft`
  - URL 上の仮 session
- `pending`
  - optimistic message / placeholder を即時表示
- `hydrating`
  - real session ID は得たが、一覧や詳細の取得が追いついていない
- `ready`
  - server entity が揃った
- `error`
  - mutation 失敗または hydration 失敗

### 3.5 ID Handoff は明示的に reconcile する

`draft session id -> real session id` のような handoff は、
もっとも blank state を生みやすい。

原則:

- handoff 中は draft と real を同一 entity として扱う
- selection, optimistic message, pending response, live activity, interrupt target は
  handoff 中に両 ID を見られるようにする
- handoff 完了条件も明示する

例:

- route が real ID に切り替わった
- raw sessions に real session が現れた
- session detail が real ID で取得できた

### 3.6 List と Detail を別世界にしない

同じ session を一覧と詳細で別の rules で描画しない。

原則:

- session の optimistic / pending state は list と detail で共有する
- detail だけ placeholder、list だけ empty のようなズレを作らない
- 同じ entity の status はなるべく同じ source から出す

### 3.7 Navigation は同期、データ取得は非同期

ユーザー操作に対する navigation は即時に反映する。
ただし navigation 後の描画は view state が受け持つ。

原則:

- user intent を表す route 変更は同期的に行う
- route 遷移の成否を query 完了に依存させない
- route 遷移直後の pane は skeleton / pending ready / placeholder で受ける

### 3.8 UI は Query Flag ではなく View Contract を受け取る

画面 component の props は、
できるだけ library 依存の生 flag ではなく、
view contract に寄せる。

良い例:

- `SidebarViewState`
- `ChatViewState`

避けたい例:

- `isLoading`
- `isFetching`
- `hasData`
- `selectedSessionSummary`
- `detailError`

を上位 component が無秩序に混ぜてそのまま渡すこと。

### 3.9 Failure も描画可能な state として持つ

失敗時にただ optimistic state を消して終わりにしない。

少なくとも以下のどちらかを選ぶ。

- temp entity を error 状態で残す
- draft に戻し、失敗理由を UI で示す

失敗が UI 上で観測不能になる設計は避ける。

### 3.10 Debugging は State Transition 単位で行う

描画不具合は DOM だけ見ても分からないことが多い。
dev 中は state transition をログで追えるようにする。

推奨:

- submit 直後の state
- route session ID
- temporary / real ID の handoff
- view state kind
- optimistic / pending response の維持条件
- streaming / live activity の開始タイミング

ログは dev-only に限定し、
entity lifecycle の境目で出す。

## 4. 現在のアプリへの適用ルール

### 4.1 Session Selection

- canonical source は URL
- `selectedSessionId` を store で重複管理しない
- mobile pane は route と viewport から導出する

### 4.2 Session View State

- session list と session detail は
  `view-state.ts` のような adapter 層で整形する
- `SidebarPane` と `ChatPane` は raw query state ではなく view state を受ける

### 4.3 New Session Flow

新規スレッド作成は以下を必須とする。

1. draft route を即時に開く
2. optimistic message を即時に表示する
3. temporary session を一覧と詳細に同時表示する
4. real session ID 受信後は transition state を張る
5. real entity が揃うまで pending UI を維持する
6. handoff 完了後に temporary state を掃除する

### 4.4 Refresh Behavior

- sessions 再取得中でも thread list は残す
- messages 再取得中でも timeline は残す
- refresh indicator は既存内容を壊さない範囲で出す

## 5. 実装チェックリスト

新しい UI / workflow を追加するときは以下を確認する。

- [ ] その事実の canonical source は 1 つだけか
- [ ] route から導出できる state を store に重複保持していないか
- [ ] entity lifecycle を言葉で説明できるか
- [ ] component が bool の寄せ集めではなく view state で描画しているか
- [ ] initial load と background refresh を分離しているか
- [ ] temporary entity を list と detail の両方で共有しているか
- [ ] ID handoff がある場合、transition state を持っているか
- [ ] 失敗時の UI が存在するか
- [ ] blank pane が発生しうる中間状態を潰せているか
- [ ] dev-only logs で遷移を追えるか

## 6. 非目標

本書は以下を直接は扱わない。

- backend protocol 設計そのもの
- DB schema 設計
- run execution permission の詳細
- 細かな visual design token

ただし、これらの実装でも
view state と entity lifecycle の考え方は適用する。
