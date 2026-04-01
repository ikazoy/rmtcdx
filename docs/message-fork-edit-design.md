# Message Fork / Edit Design

## 1. 目的

本書は、Codex Remote Web Client に
過去 message 起点の `Fork` / `Edit` UX を追加するための
設計方針を定義する。

主目的は以下である。

- Codex app-server の public protocol で実現できる範囲を明確にする
- official client に見える `Fork` / `Edit` を
  remote web client 上でどう安全に再構成するかを決める
- history と workspace が一致しないケースを
  product としてどう扱うかを固定する
- v1 と将来拡張の境界を明確にする

## 2. 前提

- 対象 runtime は `codex app-server` 経由の real mode
- 対象確認バージョンは `codex-cli 0.116.0`
- 確認日は 2026-03-31
- 根拠は以下
  - `codex --help`
  - `codex fork --help`
  - `codex app-server generate-ts`
  - 手元の実機 probe
  - 本リポジトリの現行実装

## 3. 観測できた事実

現時点で確認できる重要な事実は以下である。

- public protocol には `thread/fork` が存在する
- public protocol には `thread/rollback` が存在する
- public protocol には `message/edit` のような surface は見当たらない
- `thread/rollback` は thread history だけを戻し、
  local file changes は戻さない
- rollback 後の次 turn は、
  rollback 前から disk に残っている file state をそのまま読む
- protocol に `worktree/*` のような API は存在しない
- `ThreadResumeParams.history` は unstable かつ
  `FOR CODEX CLOUD - DO NOT USE` とされている

### 3.1 probe で確認した挙動

temp repo 上で以下を確認した。

1. Codex に `notes.txt` へ `ONE` を追記させる
2. その thread を `thread/fork` する
3. fork 先に `thread/rollback(numTurns: 1)` をかける
4. rollback 後の fork thread で `notes.txt` を読ませる

結果は以下であった。

- rollback 後も `notes.txt` は `base\nONE\n` のままだった
- rollback 後の次 turn でも Codex は `base\nONE` を読んで返した

つまり app-server の public surface だけでは、
「過去の message 時点の history へ戻す」はできても、
「その時点の workspace snapshot へ戻す」はできない。

## 4. 問題設定

official client の UI 上では、
過去 message から `Fork` / `Edit` ができるように見える。

しかし public protocol 上の実体は message-level edit ではなく、
主に以下の組み合わせで説明される。

- `thread/read`
- `thread/fork`
- `thread/rollback`
- `turn/start`

したがって remote web client で必要なのは、
「message を入口にしつつ、実装は thread-level operation に落とす」
という設計である。

同時に、
public protocol は file restore を提供しないため、
`Edit` を「元 thread をその場で書き換える操作」と見せると
誤解を生む。

## 5. 結論

### 5.1 v1 の `Edit` は「in-place edit」ではなく「edited fork」とする

v1 の product semantics は以下とする。

- `Fork`
  - 選択 message を起点に新しい branch session を作る
- `Edit`
  - 選択 message を起点に新しい branch session を作り、
    その prompt を編集可能な draft として開く

どちらも original thread を mutate しない。

### 5.2 message-level UX、thread-level 実装を採用する

UI 上は message に対する action として見せるが、
backend 実装は thread-level operation へ写像する。

原則:

- source thread は不変
- branch 先 thread を新規に作る
- branch point より後ろの turn は fork 側で落とす
- 必要な prompt は新しい turn として再送する

### 5.3 v1 では workspace を自動で戻さない

v1 では以下を product invariant とする。

- `Fork` / `Edit` は local files を自動 revert しない
- branch 後の run は current workspace state を使う
- UI はこの差分を明示的に警告する

これは public protocol の事実に合わせた設計であり、
勝手な Git reset や file overwrite を避けるためでもある。

### 5.4 v1 の action 対象は `user_message` に限定する

v1 では `Fork` / `Edit` の action 対象を user message に限定する。

理由:

- `Edit` の主語として自然なのは user prompt である
- public protocol の rollback 粒度は turn 単位であり、
  assistant message を branch point にすると意味づけが曖昧になる
- 実装と UX の複雑さを抑えられる

assistant message 起点の branch は v2 以降で検討する。

## 6. v1 の user-facing semantics

### 6.1 `Fork`

選択した user message に対する `Fork` は、
以下の意味を持つ。

- original thread を元に新しい forked session を作る
- 選択 message を含む turn と、
  それより後ろの turn を fork 側から落とす
- 選択 message の text と attachments を
  composer draft に複製する
- draft は自動送信しない
- user が内容を確認してから送信する

この意味では、
`Fork` は「同じ prompt から分岐し直すための下準備」である。

### 6.2 `Edit`

選択した user message に対する `Edit` は、
以下の意味を持つ。

- backend の branch 生成フロー自体は `Fork` と同じ
- 生成された draft をそのまま編集モードで開く
- composer を focus し、
  user が prompt を修正して再送する

この意味では、
`Edit` は「prompt が prefilled された fork」である。

### 6.3 original thread の表示

original thread 側には何も書き戻さない。

ただし fork 元との関係は UI 上で分かるようにする。

最低限必要な表示:

- new session header に `Forked from <session>` を出す
- source message への deep link を持てるようにする

## 7. backend 実装モデル

### 7.1 branch point の決め方

message row から action を起動したら、
backend はその message が属する turn index を解決する。

v1 では以下を使う。

- target message kind: `user_message`
- target turn index: その message を含む turn

branch に必要な rollback 数は以下で決める。
ここで `targetTurnIndex` は 0-based とする。

- `numTurnsToDrop = totalTurns - targetTurnIndex`

これにより、
target turn 自体も fork 側から落ちる。
その後、target user prompt を draft として再投入する。

### 7.2 fork/edit API フロー

推奨フローは以下である。

1. source thread を `thread/read(includeTurns: true)` で読む
2. target message から target turn index を解決する
3. `thread/fork` で full history の fork thread を作る
4. `thread/rollback` で target turn 以降を落とす
5. target user message の text / attachments を draft に複製する
6. forked session detail を返す

v1 では step 5 の draft 作成までで止める。
prompt 送信は user の明示操作で行う。

### 7.3 `thread/resume.history` は使わない

`ThreadResumeParams.history` は、
現時点では public-stable な surface とみなさない。

理由:

- generated TS 上で unstable 扱いである
- `FOR CODEX CLOUD - DO NOT USE` と明記されている
- remote web client の v1 で依存するにはリスクが高い

したがって v1 は
`thread/fork + thread/rollback + draft replay`
のみで構成する。

## 8. workspace semantics

### 8.1 source of truth は current disk state

branch 後に Codex が見る filesystem は、
selected message 時点の snapshot ではなく
current disk state である。

この原則を UI / backend / copy のすべてで揃える。

### 8.2 自動 revert は行わない

v1 では以下を行わない。

- `git checkout -- <path>`
- `git reset --hard`
- reverse patch の自動適用
- hidden worktree の自動作成

理由:

- user の working tree を壊しうる
- public protocol 外の副作用が大きい
- 失敗時の説明責務が急増する

### 8.3 UI warning

fork/edit で生成された session には、
少なくとも初回表示で以下の warning を出す。

- `History was branched from an earlier message, but local files were not restored.`
- `The next run will use the current workspace state.`

この warning は informational ではなく、
機能意味の中核として扱う。

### 8.4 draft を自動送信しない理由

auto-submit すると、
user が workspace の current state を認識しないまま
branch run が始まる。

そのため v1 では以下を優先する。

- fork/edit 完了
- warning 表示
- draft 確認
- user が明示的に送信

## 9. session metadata

fork/edit session には、
bridge-managed metadata として
最低限以下を保持するのが望ましい。

- `forkedFromSessionId`
- `forkedFromThreadId`
- `forkedFromTurnId`
- `forkOriginMessageId`
- `forkMode`
  - `fork`
  - `edit`
- `forkCreatedAt`

これにより以下が可能になる。

- fork 元表示
- source message deep link
- analytics / debugging
- 今後の branch graph UI 拡張

## 10. UI 仕様

### 10.1 entry point

v1 では user message card に
以下の action を出す。

- `Fork`
- `Edit`

### 10.2 completion state

fork/edit 完了後の UI は以下とする。

- new session へ遷移する
- composer に source prompt を入れる
- warning banner を表示する
- `Edit` の場合は composer を focus する

### 10.3 copy 方針

copy では以下を避ける。

- 「この message を編集しました」
- 「この session は過去時点に戻りました」

代わりに以下の意味を出す。

- 「earlier message から branch した」
- 「files は戻していない」

## 11. 非目標

v1 では以下を扱わない。

- original thread の in-place mutation
- assistant message 起点の edit
- selected message 時点の file snapshot 復元
- automatic Git revert
- clean branch 用の dedicated worktree 作成
- branch graph の可視化

## 12. 将来拡張

### 12.1 clean fork / clean edit

より official client に近い体験が必要になった場合、
将来は以下を検討できる。

- fork/edit 時に fresh managed worktree を新設する
- source repo の指定 branch / SHA から clean state を作る
- new thread の `cwd` をその managed worktree に向ける

これにより
history と filesystem のズレを大きく減らせる。

ただしこれは app-server primitive ではなく、
bridge-managed Git lifecycle を伴うため、
`docs/worktree-management-design.md` の範囲として扱う。

### 12.2 assistant message 起点の branch

将来的に assistant message 起点の `Fork` を入れる場合は、
turn 粒度と user expectation を明示的に整理する必要がある。

少なくとも以下のどちらかを選ぶ必要がある。

- assistant message を含む turn の直後から branch する
- assistant message が属する turn を落とし、
  そこまでの context だけ残す

v1 ではこの曖昧さを持ち込まない。

## 13. 推奨実装順序

1. shared types / bridge API に fork/edit request surface を追加する
2. thread read から message -> turn index 解決を実装する
3. `thread/fork` と `thread/rollback` の adapter を追加する
4. fork/edit session metadata を保存する
5. web の message action UI と draft prefill を実装する
6. warning banner と fork origin 表示を追加する

## 14. 最終方針

remote web client の `Fork` / `Edit` は、
v1 では以下として定義する。

- message を入口にした branch creation
- original thread は immutable
- selected prompt は new draft として再利用する
- files は戻さない
- current workspace state を使って次 run を始める

この方針は public app-server protocol の事実と一致しており、
予期しない file destruction を避けるうえでも妥当である。
