# File Preview and Diff Design

## 1. 目的

本書は、Codex Remote Web Client に
session 中の file change inspection と
file content preview を追加するための設計方針を定義する。

主目的は以下である。

- Codex app-server が返す `fileChange` / `turn diff` と
  Git の `diff` を product 上でどう使い分けるかを固定する
- assistant message 内の file path link を
  どう安全に解釈して preview へ接続するかを決める
- 新規作成された `.md` を含む text file を
  remote web client から preview できる v1 を定義する
- live update を前提にしない、on-demand read 型の実装に落とす

## 2. 前提

- 対象 runtime は `codex app-server` 経由の real mode
- 対象確認日は 2026-04-01
- 根拠は以下
  - OpenAI Codex app-server README
  - `codex app-server` public protocol surface
  - 現在の本リポジトリ実装
  - Remodex / Farfield の公開実装

## 3. 観測できた事実

### 3.1 app-server には file change surface がある

現時点で確認できる重要な事実は以下である。

- app-server は turn item として `fileChange` を返す
- `fileChange` には per-file `path`, `kind`, `diff` がある
- app-server には `turn/diff/updated` notification がある
- app-server には `fs/readFile`, `fs/getMetadata`, `fs/readDirectory` がある

したがって、
file inspection の主経路を
`git diff` に寄せる必然性はない。

### 3.2 この repo は既に `fileChange.diff` を保持している

現行実装では以下が成立している。

- bridge の `CodexThreadItem` は `fileChange.changes[].diff` を持つ
- `thread/read` の `fileChange` は message metadata に保存している
- `persistExtendedHistory: true` を `thread/start` / `thread/resume` に渡している

つまり、
history 上の file change data は
既に product に持ち込まれている。

### 3.3 しかし current UI は path 一覧しか出していない

現行 web UI では以下の制約がある。

- `FileChangeSheet` は file path と verb だけを表示する
- `diff` は metadata にあるが UI では描画していない
- assistant message 本文は `ReactMarkdown` で描画しているが、
  link 用 custom renderer がない
- そのため markdown link は browser の通常 anchor として扱われる

結果として、
「何が変わったか」は path レベルでしか見えず、
「ファイルの中身を見る」導線も存在しない。

### 3.4 競合も主に diff ベースであり file preview は弱い

公開実装を見る限り、
Remodex / Farfield ともに
`diff` の表示はあるが、
repo-local file link から current file content preview へ落とす設計は強くない。

したがって、
本 repo では以下を差別化ポイントとしてよい。

- structured file change surface をそのまま活かす
- assistant link と file change row の両方を
  同じ file preview surface に接続する

## 4. 問題設定

今回解きたいのは 2 つの別問題である。

1. 何が変わったかを確認する
2. そのファイルの現在内容を確認する

この 2 つを同じ source で解こうとすると、
設計が歪む。

たとえば `git diff` だけで両方を賄おうとすると、
以下の問題が出る。

- turn 単位の file change と repo-wide dirty state が混ざる
- assistant が作った変更と user が後で加えた変更を分離しにくい
- markdown link クリック時に current file preview へ直結できない

逆に assistant の markdown link だけを source of truth にすると、
以下の問題が出る。

- model が書いた link text は non-authoritative
- path typo や stale path を UI がそのまま信じてしまう
- changed file list を構造化して扱えない

したがって、
v1 は source を分離するべきである。

## 5. 設計原則

### 5.1 change detection と content preview を分離する

source of truth は以下とする。

- changed files の一覧
  - app-server の `fileChange`
- file diff
  - `fileChange.changes[].diff`
- current file content
  - app-server の `fs/readFile` + `fs/getMetadata`

### 5.2 assistant markdown link はヒントであり真実ではない

assistant message 中の file path link は
preview を開く入口として使ってよい。

ただし、
link 自体を authoritative data とはみなさない。

product 上の意味づけは以下とする。

- link text / href は preview 解決の入力
- preview 結果は bridge 側の path resolution と
  app-server `fs/*` response を正とする

### 5.3 live update は v1 の非目標とする

v1 は on-demand read only とする。

- modal / sheet を開いた時に 1 回だけ fetch する
- watch / polling / `turn/diff/updated` streaming は使わない
- refresh は必要なら user initiated action に限る

### 5.4 repo-wide git diff viewer は v1 の主経路にしない

`git diff` 自体は将来の補助機能として有用である。
ただし今回の feature の主経路にはしない。

理由:

- session-scoped file change inspection と責務が違う
- current repo dirty state は session history と一致しない
- first implementation が不要に重くなる

### 5.5 preview 不可時は嘘をつかず fallback する

以下は v1 の invariant とする。

- file が読めない場合は preview を捏造しない
- missing file は missing と表示する
- binary file は binary と表示する
- `diff` がある場合のみ diff tab を fallback として見せる

特に、
file が既に削除されている過去 session に対して
`diff` から無理に全文復元しない。

## 6. 結論

### 6.1 v1 の主経路は app-server だけで閉じる

v1 の file inspection surface は以下で構成する。

- `fileChange`
  - changed file list
  - per-file diff
- `fs/getMetadata`
  - exists / directory / size / modifiedAt
- `fs/readFile`
  - current file content

### 6.2 入口は 2 つ、preview surface は 1 つに統一する

entry point は以下。

- file change row tap
- assistant markdown link click

ただし遷移先 UI は同一にする。

これにより、
path 解決・permission error・fallback 表示の責務が
1 箇所に集約される。

### 6.3 v1 の preview は「current file」を見る

preview が見せるものは
selected message 時点の snapshot ではなく、
現在 disk にある file content である。

これは worktree / rollback 設計と整合させる。

同時に diff tab を併設することで、
「今の内容」と「その turn での変更」を分離して見せる。

## 7. User-Facing Semantics

### 7.1 file change row

`FileChangeSheet` の各 row は button 化する。

tap 時の意味は以下。

- selected path の file preview を開く
- diff がある場合は `Diff` tab を持つ
- markdown file なら `Preview` tab を既定表示にする

### 7.2 assistant markdown link

assistant message 内の markdown link は
以下の場合のみ in-app preview として解釈する。

- relative path link
- absolute path link
- current session の repo root / cwd 配下へ安全に解決できる link

上記以外は通常 link として扱う。

### 7.3 preview surface

v1 の preview surface は bottom sheet または full-screen modal とし、
最低限以下を持つ。

- title
  - display path
- meta
  - current status
  - content kind
- tabs
  - `Preview`
  - `Source`
  - `Diff`

tab の表示条件は以下。

- `Preview`
  - markdown text のみ
- `Source`
  - text file のみ
- `Diff`
  - `diff` が存在する時のみ

### 7.4 markdown file の扱い

`.md` / `.mdx` / `README` 系 text file は
markdown preview を優先する。

ただし v1 の renderer は message renderer と揃え、
以下に留める。

- GFM
- code block
- table
- blockquote
- list
- mermaid は後回し

### 7.5 non-markdown text file の扱い

`.ts`, `.json`, `.yml`, `.txt` などは
`Source` tab を既定表示にする。

syntax highlight は既存 code block renderer と
できるだけ共通化する。

### 7.6 binary / directory / missing file の扱い

以下は v1 で preview 対象外とする。

- binary file
- directory
- path traversal で拒否された path
- deleted / moved などで current file が存在しない path

この場合は状態を明示し、
`Diff` tab があればそちらだけ開けるようにする。

## 8. API Design

### 8.1 shared-types

以下の追加を推奨する。

```ts
export type SessionFilePreviewRequest = {
  path: string;
  diff?: string | null;
  changeKind?: "add" | "delete" | "update" | null;
  movePath?: string | null;
};

export type SessionFilePreviewContentStatus =
  | "ok"
  | "missing"
  | "directory"
  | "binary"
  | "too_large";

export type SessionFilePreviewResponse = {
  path: string;
  resolvedPath: string | null;
  contentStatus: SessionFilePreviewContentStatus;
  mediaType: string | null;
  sizeBytes: number | null;
  isMarkdown: boolean;
  text: string | null;
  diff: string | null;
  changeKind: "add" | "delete" | "update" | null;
  movePath: string | null;
};
```

ポイント:

- `diff` は request でも response でも持てるようにする
- response は text-only を前提にし、
  binary 本体は返さない
- `resolvedPath` は UI で display / debug に使う

### 8.2 bridge route

route は以下を推奨する。

- `POST /api/sessions/:sessionId/files/preview`

`GET` ではなく `POST` を推奨する理由:

- body に `path`, `diff`, `changeKind` を自然に載せられる
- 既存の bridge でも body 付き action/read に `POST` がある

### 8.3 CodexBackend extension

bridge の `CodexBackend` には以下を追加する。

```ts
readFile(path: string): Promise<{ dataBase64: string }>;
getFileMetadata(path: string): Promise<{
  isDirectory: boolean;
  isFile: boolean;
  createdAtMs: number | null;
  modifiedAtMs: number | null;
  sizeBytes?: number | null;
}>;
```

実体は app-server の以下へ thin に委譲する。

- `fs/readFile`
- `fs/getMetadata`

### 8.4 path resolution

bridge では以下の順序で path を解決する。

1. session の authoritative `cwd` を取得する
2. request `path` が relative なら `cwd` 基準で resolve する
3. absolute path ならそのまま使う
4. normalized path が repo root / session cwd 配下か確認する
5. 配下でなければ reject する

ここでの重要点:

- browser に raw local path access を渡さない
- 最終判断は bridge が行う
- relative path の解決基準は message text ではなく session cwd

### 8.5 size limit

text preview には bridge 側 limit を設ける。

推奨:

- 256 KB までは全文
- 256 KB 超は `too_large`

理由:

- mobile-first UI で重い preview を避ける
- initial implementation を単純に保つ

## 9. Web Implementation

### 9.1 shared preview state

web には session detail / chat pane で共有する
`filePreviewState` を追加する。

最低限必要な state:

- `sessionId`
- `requestedPath`
- `status`
  - idle / loading / ready / error
- `response`

### 9.2 file change row -> preview

`FileChangeSheet` の row は static div ではなく button に変える。

押下時に preview request を発行する。

この時、
既に message metadata にある以下を request へ渡す。

- `path`
- `diff`
- `kind`
- `movePath`

### 9.3 markdown link -> preview

`MessageBody` の `ReactMarkdown` に
`a` renderer を追加する。

処理は以下。

1. `href` を受け取る
2. repo-local file path と判定できるなら `preventDefault()`
3. preview state を開く
4. それ以外は通常 link として描画する

この renderer では
`target="_blank"` を雑に付けるのではなく、
internal preview と external navigation を分岐する。

### 9.4 preview tabs

tab の初期選択は以下を推奨する。

- markdown + `contentStatus === "ok"`
  - `Preview`
- text + `contentStatus === "ok"`
  - `Source`
- content unavailable + `diff` available
  - `Diff`

### 9.5 rendering reuse

renderer は既存 UI を使い回す。

- markdown
  - 現在の `MessageBody` 相当 renderer
- source
  - 既存 code block / pre styling
- diff
  - 追加 lines / removed lines を色分けする専用 block

message 本文用 renderer と preview 用 renderer は
完全共有でなくてよいが、
markdown / code styling token は共有する。

## 10. Security and Correctness

### 10.1 browser は local file を直接開かない

`file://` や absolute local path を
そのまま browser navigation へ渡さない。

すべて bridge 経由で読む。

### 10.2 repo boundary を超える path は拒否する

以下は reject 対象とする。

- `../` で repo root を抜ける relative path
- 別 repo への absolute path
- session cwd と無関係な path

### 10.3 assistant output を信用しすぎない

assistant が書いた markdown link は
preview を開く trigger に過ぎない。

UI copy 上も以下を徹底する。

- current file
- current workspace
- file no longer exists

つまり、
message 時点 snapshot であるかのような copy は避ける。

## 11. v1 / v2 Boundary

### 11.1 v1 に入れるもの

- file change row からの diff / file preview
- assistant markdown link からの file preview
- markdown preview
- text source preview
- missing/binary fallback

### 11.2 v1 に入れないもの

- live update
- `turn/diff/updated` の前面表示
- repo-wide git diff viewer
- binary asset preview
- historical snapshot reconstruction
- diff からの全文復元

### 11.3 v2 以降で検討するもの

- manual refresh
- image / pdf preview
- generated file compare against current HEAD
- preview from plain path mention without markdown link
- content watch / stale badge

## 12. 推奨導入順序

1. `FileChangeSheet` に `Diff` tab を追加する
2. bridge に `files/preview` route と `fs/readFile` adapter を追加する
3. file change row から current file preview を開けるようにする
4. markdown link renderer を override して同じ surface に接続する

この順序を推奨する理由:

- 既に持っている `diff` から先に user value を出せる
- preview route ができてから link handling をつなぐ方が自然
- state model を 1 回で固められる

## 13. この repo に対する具体的な変更点

実装時に主に触る箇所は以下である。

- bridge
  - `apps/bridge/src/codex/types.ts`
  - `apps/bridge/src/codex/real-client.ts`
  - `apps/bridge/src/codex/mock-client.ts`
  - `apps/bridge/src/app.ts`
- shared
  - `packages/shared-types/src/index.ts`
- web
  - `apps/web/src/features/chat/ChatPane.tsx`
  - preview UI の新規 component

## 14. 結論

file inspection は、
以下の 3 つを明確に分離して設計するのが最も筋がよい。

- change index
  - `fileChange`
- current content preview
  - `fs/readFile`
- repo-wide dirty state
  - 将来必要なら `git diff`

v1 では
`fileChange` と `fs/readFile` に絞る。

これにより、
session 中に新規作成された markdown file を
preview できるようにしつつ、
差分確認も同じ surface で提供できる。
