# Worktree Management Design

## 1. 目的

本書は、Codex Remote Web Client に
Git worktree 管理を追加するための設計方針を定義する。

目的は以下の 4 点である。

- `codex app-server` protocol でできることと、できないことを分離する
- bridge が持つべき worktree 管理責務を明確にする
- v1 で実装する範囲と、v2 以降へ送る範囲を固定する
- 現行コードベースに無理なく乗る移行順序を決める

## 2. 前提

- 対象 runtime は `codex app-server` 経由の real mode
- 対象確認日は 2026-03-29
- 根拠は以下
  - OpenAI Codex App Server docs
  - OpenAI Codex App Worktrees docs
  - 本リポジトリの現行実装

現時点で確認できる重要な事実は以下である。

- app-server protocol には `worktree/*` のような管理 API は存在しない
- app-server 側が持つのは主に `thread/*`、`turn/*`、`command/exec`、`fs/*` と
  `cwd` 指定である
- worktree は Codex App の product feature であり、protocol primitive ではない

したがって remote web client で worktree を扱うには、
bridge 側で Git worktree を管理し、その結果得た path を
`thread/start` / `thread/resume` / `turn/start` に渡す必要がある。

## 3. 結論

### 3.1 worktree 管理は bridge の責務とする

推奨設計は以下である。

- bridge が Git worktree の作成・一覧・状態確認を行う
- Codex app-server には worktree path を `cwd` として渡すだけにする
- worktree metadata は bridge-managed な永続 state に保持する
- UI は repo の下にぶら下がる execution target として worktree を扱う

### 3.2 v1 は「managed worktree session」に限定する

v1 で採用するのは以下である。

- session 新規作成時に `local` または `managed_worktree` を選べる
- `managed_worktree` では bridge が `git worktree add --detach` を実行する
- 1 session は 1 managed worktree に固定される
- session 一覧・detail・chat header で実行先を表示する
- repo 一覧は引き続き `repos.json` のルート repo 単位で表示する

### 3.3 v1 では handoff と permanent worktree を入れない

以下は v2 以降へ送る。

- local <-> worktree の handoff
- permanent worktree を 1 つの repo の別 project として扱うこと
- local checkout の未 commit 変更を worktree に持ち込むこと
- archived session に対する自動 worktree cleanup
- 1 worktree を複数 session で共有すること

## 4. 現状実装の制約

現行実装には、worktree を入れるうえで無視できない制約がある。

### 4.1 runtime は live catalog 直結である

`apps/bridge/src/app.ts` では `LiveCatalogService` を直接組み込み、
repo / session 一覧を app-server の `thread/list` から組み立てている。

このため現状の session は実質的に
「Codex thread をそのまま UI に出したもの」に近い。

### 4.2 新規 session は常に repo root で始まる

`apps/bridge/src/catalog/live-catalog-service.ts` の `createSession()` は、
選択 repo の `path` をそのまま `codex.createThread()` に渡している。

したがって、現状は session 作成時に
execution target を切り替える余地がない。

### 4.3 run 再開時の `cwd` は thread から引いている

`apps/bridge/src/runs/run-service.ts` は既存 session に対して
`catalog.getThread(sessionId)` を読み、その `thread.cwd` を
次の run の `cwd` にしている。

このため、worktree path を session metadata として持たないままでは、
「この session はどの worktree に属するか」を
bridge 側で厳密に制御しにくい。

### 4.4 session metadata 用の永続 store はまだ存在しない

現行 runtime がローカルに保持しているのは、push notification 用の小さい file-backed state だけである。
repository / session / run の catalog は `codex app-server` から live に組み立てており、
worktree metadata を保持する専用 store はまだない。

つまり worktree 管理を入れるなら、
metadata 用の永続 store を新設する必要がある。

## 5. プロダクト要件

## 5.1 目標

v1 の目標は以下である。

- local checkout を壊さずに並列 task を走らせられる
- session 作成時に worktree を選べる
- worktree の起点 branch / ref を指定できる
- 既存の repo grouping を崩さない
- app-server protocol に存在しない概念を bridge で吸収する

## 5.2 非目標

v1 では以下を扱わない。

- Codex App の Handoff を完全再現すること
- PR 作成や branch publish までを bridge API に含めること
- arbitrary path に worktree を作れるようにすること
- generic Git API を browser に公開すること

## 6. 用語

- repo root:
  - `repos.json` に登録された対象 repository の root path
- local target:
  - repo root そのものを `cwd` として使う実行先
- managed worktree:
  - bridge が session 専用に自動作成・管理する Git worktree
- permanent worktree:
  - 長寿命で複数 session から使える worktree。v2 以降
- session:
  - remote web client 上の会話単位。v1 では `sessionId === threadId`
- Codex thread:
  - app-server 上の会話単位

## 7. 設計原則

### 7.1 protocol にない責務を app-server に期待しない

worktree の lifecycle は protocol 外なので、
bridge が Git 操作を明示的に持つ。

### 7.2 browser には高レベル操作だけを出す

クライアントに見せるのは以下に限定する。

- local で session を作る
- managed worktree で session を作る
- branch / ref を選ぶ
- worktree 状態を確認する

`git worktree add` や `git worktree remove` を
そのまま叩ける API は出さない。

### 7.3 v1 の managed worktree は session と 1:1 にする

1 つの managed worktree を複数 session で共有すると、
cleanup と UI の責務が急に複雑になる。

v1 では以下を invariant とする。

- managed worktree は 1 session 専用
- session は作成後に target を変えない
- managed worktree は detached HEAD で始める

### 7.4 repo 一覧の主語は引き続き root repo にする

worktree は repo の下に属する execution target として扱い、
top-level repo 一覧を worktree で増殖させない。

## 8. 推奨アーキテクチャ

## 8.1 コンポーネント

bridge には以下の責務分離を入れる。

### `GitWorktreeService`

責務:

- repo が Git 管理下か確認する
- branch / ref 一覧を取得する
- managed worktree を作成する
- repo ごとの worktree 一覧を取得する
- worktree path が実在するか、Git から見て有効かを確認する

### `SessionCatalogService`

責務:

- bridge-managed な repo / session / worktree metadata store を source of truth にする
- app-server の thread 情報を session metadata に重ねて返す
- legacy thread の import / backfill を行う

### `CodexThreadAdapter`

責務:

- `thread/read`, `thread/list`, `thread/start`, `thread/resume`, `turn/start` を thin に扱う
- worktree 概念は持たない

### `RunService`

責務:

- session metadata から実行先 `cwd` を引く
- local / worktree を問わず Codex 実行を開始する
- missing worktree を検知したら run を拒否する

## 8.2 現行実装への適用方針

現行の `LiveCatalogService` は
「app-server 上の thread をそのまま session に見立てる」実装である。

worktree を入れる v1 では、これを完全撤去するより以下の移行が安全である。

1. session / worktree metadata 用の persistent store を導入する
2. session row を thread metadata の overlay として使う
3. session id は当面 `threadId` をそのまま使う
4. worktree metadata だけは bridge-managed state で保持する
5. session 一覧は metadata store を主、app-server を従にして返す

この方針なら frontend の `sessionId` 契約を壊さずに進められる。

## 9. データモデル

## 9.1 session id の扱い

v1 では後方互換を優先し、以下を採用する。

- `sessions.id = codex_thread_id`
- API 上の `sessionId` は従来どおり thread id を使う

将来 handoff や imported session の扱いが複雑化した場合にのみ、
v2 で app session id を分離する。

## 9.2 `sessions` 拡張

既存 `sessions` table に以下を追加する。

- `execution_target_kind TEXT NOT NULL`
  - `local | managed_worktree | permanent_worktree`
- `worktree_id TEXT NULL`
- `cwd_snapshot TEXT NOT NULL`
- `resume_capability TEXT NOT NULL DEFAULT 'read_write'`
  - v1 では `read_write` または `missing_target`

補足:

- local session では `worktree_id = NULL`
- managed worktree session では `worktree_id != NULL`
- `cwd_snapshot` は session 作成時点の実行先を保持する

## 9.3 `worktrees` 新設

新規 table を追加する。

```sql
CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  session_id TEXT UNIQUE REFERENCES sessions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  base_ref TEXT NOT NULL,
  base_commit_sha TEXT NOT NULL,
  head_branch TEXT,
  head_sha TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);

CREATE INDEX idx_worktrees_repo_updated ON worktrees(repo_id, updated_at DESC);
CREATE INDEX idx_worktrees_status ON worktrees(status);
```

想定 enum:

- `kind`
  - `managed`
  - `permanent`
- `status`
  - `active`
  - `missing`
  - `deleting`
  - `deleted`
  - `error`

v1 で使うのは `kind = managed` が中心である。

## 9.4 repo metadata

`repositories` table は引き続き `repos.json` と同期する。
worktree はここに別 repo として登録しない。

必要に応じて read model 側で以下を追加してよい。

- `isGitRepo`
- `defaultBranch`
- `managedWorktreeCount`

## 10. 公開 API 設計

## 10.1 session 作成 API 拡張

`POST /api/sessions` を以下へ拡張する。

```ts
type CreateSessionRequest =
  | {
      repoId: string;
      title?: string;
      target?: { kind: "local" };
    }
  | {
      repoId: string;
      title?: string;
      target: {
        kind: "managed_worktree";
        baseRef?: string;
      };
    };
```

ルール:

- `target` 省略時は `local`
- `managed_worktree` では `baseRef` を省略可能
- `baseRef` 未指定時は repo の現在 branch、取得不能なら `HEAD`

## 10.2 branch list API

新規 endpoint:

- `GET /api/repos/:repoId/branches`

用途:

- new session UI の branch picker

返却内容の最小案:

```ts
type RepoBranch = {
  name: string;
  ref: string;
  isCurrent: boolean;
  isRemote: boolean;
};
```

## 10.3 worktree list API

新規 endpoint:

- `GET /api/repos/:repoId/worktrees`

用途:

- repo detail で managed worktree 状態を確認する
- 将来の cleanup UI に備える

v1 では read-only で十分である。
public API からの削除操作はまだ出さない。

## 10.4 session detail 拡張

`GET /api/sessions/:sessionId` に以下を追加する。

```ts
type ExecutionTarget =
  | {
      kind: "local";
      cwd: string;
      repoPath: string;
      branch?: string;
    }
  | {
      kind: "managed_worktree";
      cwd: string;
      repoPath: string;
      baseRef: string;
      headBranch?: string | null;
      status: "active" | "missing" | "error";
      worktreeId: string;
    };
```

## 11. Git 操作設計

## 11.1 基本方針

Git 操作は shell 文字列ではなく `execFile` で行う。
クライアント入力は `repoId` と `baseRef` のみ受け、
path は server 側で決定する。

## 11.2 worktree path

managed worktree の作成先は以下を推奨する。

- `<DATA_DIR>/worktrees/<repoId>/<worktreeId>`

理由:

- repo root を汚さない
- cleanup 対象を 1 箇所に集約できる
- path を client に選ばせずに済む

## 11.3 create

作成フローは以下。

1. `repoId` から repo root を解決する
2. `git rev-parse --show-toplevel` で Git repo であることを確認する
3. `baseRef` を `git rev-parse --verify <baseRef>` で commit に解決する
4. `git worktree add --detach <worktreePath> <baseRef>` を実行する
5. `git -C <worktreePath> rev-parse HEAD` で `headSha` を読む
6. `thread/start` を `cwd = <worktreePath>` で実行する
7. session / worktree row を保存する

重要:

- v1 では detached HEAD を既定とする
- local の unstaged changes は引き継がない

## 11.4 list / reconcile

bridge 起動時または repo 選択時に、必要に応じて以下を読む。

- `git worktree list --porcelain`

用途:

- DB にある worktree path が Git から見て有効か確認する
- path 消失や admin 情報破損を `missing` / `error` に落とす

ただし v1 では「bridge 管理外の worktree を自動 import」しない。
誤ってユーザー管理 worktree を取り込まないためである。

## 11.5 delete

削除は v1 の public feature には含めない。

理由:

- session がその path を `cwd` として保持している
- 削除後に resume 不能となる
- archive と delete をどう結び付けるかの product 判断がまだ必要

運用上必要なら、開発者用メンテナンスコマンドとして
後から追加する。

## 12. Session lifecycle

## 12.1 local session

1. UI で repo を選ぶ
2. `target.kind = "local"` で session を作る
3. bridge は `repo.path` を `cwd` にして `thread/start`
4. session metadata に `execution_target_kind = local` を保存する

## 12.2 managed worktree session

1. UI で repo と branch / ref を選ぶ
2. bridge が managed worktree を作成する
3. bridge は worktree path を `cwd` にして `thread/start`
4. session metadata に `execution_target_kind = managed_worktree` を保存する
5. 以後の run は常にその worktree path で再開する

## 12.3 既存 session 再開

session 再開時の `cwd` 解決は以下。

- local:
  - `repo.path`
- managed worktree:
  - `worktrees.path`

managed worktree path が消えていた場合は、
自動的に local へフォールバックしない。
その session は `missing_target` として扱い、
明示エラーを返す。

## 13. UI 設計

## 13.1 new session UI

新規 session composer で以下を出す。

- target selector
  - `Local`
  - `Worktree`
- `Worktree` 選択時だけ branch picker

初期値:

- target: `Local`
- branch: repo current branch

## 13.2 session row

thread / session row に以下の compact badge を出す。

- `Local`
- `Worktree`

worktree badge は詳細 tooltip までは不要で、
まずは target 種別が見えればよい。

## 13.3 chat header

chat header では以下を出す。

- target kind
- branch または base ref
- worktree status が `missing` / `error` の場合は banner

## 13.4 repo detail

repo 単位で managed worktree 一覧を見られるようにする。

表示項目の最小案:

- target session title
- path
- base ref
- current sha
- status
- updatedAt

## 14. 互換性と移行

## 14.1 legacy thread の import

現行アプリには、すでに app-server 側へ保存された thread がありうる。
session 一覧を DB 主体へ切り替える場合、
それらを表示できなくなると退行になる。

そこで起動時に以下を行う。

1. `thread/list` を取得する
2. DB に存在しない thread を local session として import する
3. `sessions.id = thread.id` で保存する
4. `execution_target_kind = local`
5. `cwd_snapshot = thread.cwd`

これにより既存 thread は読み継げる。

## 14.2 repos.json との関係

`repos.json` は引き続き root repo のみを定義する。
worktree を `repos.json` へ追加する必要はない。

## 15. 障害時挙動

## 15.1 repo が Git 管理下でない

- `Worktree` 選択肢を disabled にする
- API では `400 Bad Request`

## 15.2 `baseRef` が不正

- worktree を作らずに `400 Bad Request`
- error message は Git の raw stderr をそのまま出さず、要約する

## 15.3 worktree path が消えた

- `worktrees.status = missing`
- session は read-only history としては表示できる
- 新しい run は拒否する

## 15.4 app-server 上の thread はあるが worktree metadata が壊れている

- session detail で degraded state を返す
- bridge は勝手に local へ寄せない

## 16. セキュリティ方針

- worktree の親 repo は `repos.json` 登録済み repo に限定する
- worktree path は server 固定ディレクトリ配下に限定する
- browser から arbitrary path を受け取らない
- browser から generic Git command を受け取らない
- `baseRef` は Git ref として検証してから使う

## 17. 実装フェーズ

## Phase 1: backend foundation

- Database を runtime に戻す
- `repositories` 同期を有効化する
- `worktrees` table を追加する
- `GitWorktreeService` を追加する
- legacy thread import を入れる

## Phase 2: session creation flow

- `POST /api/sessions` を target 対応に拡張する
- `GET /api/repos/:repoId/branches` を追加する
- local / managed worktree の session 作成を実装する

## Phase 3: read model / UI

- session detail に execution target を出す
- session row / chat header に badge を出す
- repo detail に worktree 一覧を出す

## Phase 4: recovery and maintenance

- startup reconcile を入れる
- missing worktree surface を整える
- メンテナンス用 cleanup 手段を検討する

## Phase 5: future

- handoff local <-> worktree
- permanent worktree
- delete / prune UI
- branch 作成や publish 補助

## 18. 受け入れ条件

v1 は以下を満たせば成立とみなす。

- session 作成時に `Local` / `Worktree` を選べる
- `Worktree` を選ぶと bridge が Git worktree を作成する
- 以後の run はその worktree path で再開される
- session 一覧は root repo 配下にまとまって見える
- missing worktree を silent fallback せず明示エラーにできる
- app-server protocol に `worktree/*` を仮定しない

## 19. 未決事項

- archived session と worktree cleanup の product policy
- permanent worktree を repo と同列に見せるか、repo 配下に見せるか
- local 変更を含む branch から worktree を切る体験を後でどこまで再現するか
- app session id を thread id から分離する必要が将来どこで出るか

## 20. 参考

- OpenAI Codex App Server
  - https://developers.openai.com/codex/app-server
- OpenAI Codex Worktrees
  - https://developers.openai.com/codex/app/worktrees
- 現行コード
  - `apps/bridge/src/app.ts`
  - `apps/bridge/src/catalog/live-catalog-service.ts`
  - `apps/bridge/src/runs/run-service.ts`
  - `apps/bridge/src/db/database.ts`
