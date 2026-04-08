# Codex Remote Web Client

[English](./README.md) | [日本語](./README.ja.md)

Codex Remote Web Client は、mobile-first の Web UI から OpenAI Codex CLI をリモート操作するためのアプリです。ローカルリポジトリを選択し、session を作成して prompt を送り、run の進行をリアルタイムに追い、message 履歴を 1 つの画面で確認できます。

## できること

- `npx rmtcdx` / `bunx rmtcdx` で one-command 起動できる
- Codex thread から見つけた repository、任意の `repos.json` preset、現在の git working tree fallback を一覧表示できる
- session 一覧の検索、filter、未読管理、rename、archive
- 画像添付付き prompt の送信
- WebSocket による run 状態と message のリアルタイム更新
- ブラウザ push 通知と Codex 利用量表示
- session list と chat を行き来しやすい mobile-first レイアウト

## なぜ `rmtcdx` なのか

`rmtcdx` が狙っているのは、「ローカルの Codex を、席を離れたあとも止めずに使い続けること」です。desktop-native な Codex app や、別の coding agent の companion 製品とは、重視している体験が少し違います。

比較のスナップショット: 2026 年 4 月。

| 重視すること | Claude Code Remote Control | Codex app | `rmtcdx` |
|---|---|---|---|
| 席を離れたあとも作業を続けたい | Claude workflow の mobile / browser companion | 強い native desktop 体験 | ローカル `codex` CLI の desk-to-phone / desk-to-browser handoff を主目的にしている |
| 手元にある端末ですぐ開きたい | すでに Claude 中心なら相性がよい | 普段のメイン desktop に張り付くなら相性がよい | phone / tablet / desktop で同じ browser / PWA UI を使える |
| 長い run が終わったら呼び戻してほしい | そこが主訴の製品ではない | desktop では強い | run 完了や attention-needed をブラウザ push 通知で受けられる |
| できるだけ早く remote access を始めたい | 製品ごとの導入フローがある | desktop app の install が前提 | `npx rmtcdx up` で起動して、表示された URL を開くだけ |
| 別の hosted workspace ではなく、自分のマシンをそのまま使いたい | Claude 側の workflow に依る | 同一マシンで完結する native Codex 体験 | すでに手元で動いている local `codex` CLI を別デバイスから操作するための設計 |

`rmtcdx` が刺さるポイント:

- すでに持っている local repository、local CLI、local session history をそのまま使い続けられる
- 別 PC、phone、tablet から同じ UI を開ける。専用 client install を前提にしない
- 長い run が終わったときや Codex が attention を求めたときにブラウザ push 通知で戻れる
- same-network URL をすぐ共有でき、外から使いたいときは `npx rmtcdx up --tailscale` でそのまま広げられる
- 既存の Codex threads、`repos.json`、または現在の git working tree からすぐ始められる

## Power User 向けの次

次に広げる control surface は、単なる wishlist ではなく、すでに設計を切ってあります。

- managed worktree session
- message ベースの fork / edit
- plan-first workflow control

詳しくは [worktree management design](./docs/worktree-management-design.md)、[message fork / edit design](./docs/message-fork-edit-design.md)、[plan-first workflow design](./docs/plan-first-workflow-design.md) を参照してください。

## 前提

- Node.js 20 以上
- npm または bun
- Codex と接続して動かす場合はローカルに `codex` CLI が入っていること

## One-Command Start

```bash
npx rmtcdx up
# または
bunx rmtcdx up
```

このコマンドは `rmtcdx` をバックグラウンドで起動し、ローカル URL、private IPv4 が見つかったときの same-network URL、そして外からスマホで Codex につなぎたいときの `--tailscale` 案内を表示します。

あとでバックグラウンド process を止めるには:

```bash
npx rmtcdx stop
```

現在の状態を確認するには:

```bash
npx rmtcdx status
```

subcommand なしの `npx rmtcdx` は `npx rmtcdx up` と同じ扱いです。

`repos.json` がなくても、起動したカレントディレクトリが git repository 配下なら、その repository を pinned entry として自動で使えます。

複数 repository を永続的に登録したい場合は、app config directory に `repos.json` を作成してください。

- macOS: `~/Library/Application Support/rmtcdx/repos.json`
- Linux: `~/.config/rmtcdx/repos.json`
- Windows: `%APPDATA%\\rmtcdx\\repos.json`

state の保存先も source tree の外です。

- macOS: `~/Library/Application Support/rmtcdx`
- Linux: `~/.local/share/rmtcdx`
- Windows: `%LOCALAPPDATA%\\rmtcdx`

## 永続化する state

bridge がローカルに保持する server-owned state は最小限です。

- `state.json`: push subscription と生成済み VAPID key
- `uploads/`: web client から送った画像添付
- `codex-app-server.jsonl`: 任意の bridge デバッグログ

session / message 履歴、thread title、archive 状態、run 履歴は `codex app-server` 越しに Codex thread からその都度読みます。bridge 側でそれらをローカル DB に複製しません。

`rmtcdx` は既定で自前の `codex app-server` process を起動しますが、その child は現在の OS ユーザーと同じ Codex home directory を参照します。そのため、Codex Desktop が起動していなくても `rmtcdx` から同じ thread catalog を見られます。

## Source Checkout

```bash
git clone https://github.com/ikazoy/rmtcdx.git
cd rmtcdx
npm install
npm run build
# 任意: 初回の空状態用に repository picker を先に埋める
cp repos.example.json repos.json
PORT=3210 npm run start
```

`npm run start` は既定で `CODEX_MODE=auto` を使います。`codex` CLI が利用できれば bridge はそれに接続し、利用できない場合は自動で mock mode にフォールバックします。

`repos.json` が無くてもアプリは起動します。その場合の repository picker は、既存の Codex thread から自動で作られます。まだ thread が 1 件も無い場合は、対象 git repository 配下から起動するか、`repos.example.json` をコピーして最初の workspace を用意するのが一番簡単です。

起動後:

- App: [http://127.0.0.1:3210](http://127.0.0.1:3210)
- Health check: [http://127.0.0.1:3210/healthz](http://127.0.0.1:3210/healthz)

## Tailscale 経由で別ネットワークから使う

外からスマホで Codex につなぎたいときは、組み込みの Tailscale オプション付きで起動します。

```bash
npx rmtcdx up --tailscale
```

このモードでは起動前に `tailscale` command の存在と利用可能性を確認します。preflight に失敗した場合、`rmtcdx` はバックグラウンドで起動したままになりません。

bridge と Tailscale Serve 設定をまとめて止めるには:

```bash
npx rmtcdx stop
```

ポイント:

- `rmtcdx up` は `0.0.0.0` bind で起動するので、表示された same-network URL から LAN 上の別デバイスでも開けます
- このアプリは `/api` と `/ws` を相対パスで使うので、同じ Tailscale URL 経由で UI と WebSocket の両方が動きます
- `rmtcdx` は proxy を有効化する前に既存の Tailscale Serve 設定をバックアップし、`rmtcdx stop` でその設定に戻します
- 初回に `Serve is not enabled on your tailnet` と出た場合は、コマンドが表示する admin URL を一度開いて node で Serve を有効化し、その後で `npx rmtcdx up --tailscale` を再実行してください
- ポート 3000 は bridge 側の開発サーバー (`npm run dev`) 用に予約されています。Web 側の開発サーバーの既定値は 4173 で、`WEB_PORT` で変更できます

CLI の詳しい仕様: [docs/cli.ja.md](./docs/cli.ja.md)

## `repos.json` を準備する

`repos.json` は任意です。source checkout では既定値は `<workspace>/repos.json`、配布 package では上に書いた app config directory 配下です。

ファイルがある場合、bridge はそれを使って repository picker を先に埋めたり、表示名、description、pinned 状態を上書きしたりします。`repos.json` が無い場合、アプリは既存の Codex thread から repository を見つけて表示します。Codex の履歴が完全に空の状態から始めるなら、`repos.json` を追加するか、対象 git repository の中から起動するのが最も簡単です。

preset を追加したい場合は、まずテンプレートをコピーしてください。

```bash
cp repos.example.json repos.json
```

例:

```json
[
  {
    "id": "remote_control_codex",
    "name": "rmtcdx",
    "path": ".",
    "description": "This cloned workspace",
    "pinned": true
  }
]
```

ポイント:

- `path` は絶対パスでも相対パスでも使えます
- 相対パスは `repos.json` が置かれているディレクトリ基準で解決されます
- まずは `"path": "."` のまま、この clone 済み repo 自体を対象にするのが一番簡単です
- `repos.json` がなくても、git repository の中から起動すればその repository が自動で追加されます

## 開発

開発時に bridge と web を同時に起動するには:

```bash
npm run dev
```

Web 側の dev server は既定で `http://127.0.0.1:4173` です。`WEB_PORT=4321 npm run dev` のように変更できます。

個別ワークスペース用コマンド:

```bash
npm run dev -w rmtcdx
npm run dev -w @codex-remote/web
npm run build -w rmtcdx
npm run build -w @codex-remote/web
```

開発と release の運用: [docs/pr-and-release-workflow.ja.md](./docs/pr-and-release-workflow.ja.md)

### package 化した起動経路のローカル確認

CI と同じ packaged CLI smoke test:

```bash
npm run smoke:package
```

`npm publish` 前に、生成した tarball から `npx rmtcdx` 相当の経路を手動で確認することもできます。

```bash
npm pack -w rmtcdx
TMP_DIR="$(mktemp -d)"
PORT=33210 HOST=127.0.0.1 CODEX_MODE=mock \
REPO_CONFIG_PATH="$TMP_DIR/repos.json" \
DATA_DIR="$TMP_DIR/data" \
npm_config_cache="$TMP_DIR/npm-cache" \
npx --yes --package ./rmtcdx-0.1.0.tgz rmtcdx up
```

別ターミナルで:

```bash
curl http://127.0.0.1:33210/healthz
curl http://127.0.0.1:33210/api/repos
```

片付けるときは:

```bash
rm -rf "$TMP_DIR" ./rmtcdx-0.1.0.tgz
```

temp directory を消す前に、起動中の bridge を `Ctrl+C` で止めてください。

### Mock Mode

Codex CLI を使わずに UI や bridge の動作確認をしたい場合は mock mode を使います。

```bash
CODEX_MODE=mock npm run start
```

### Codex app-server デバッグログ

real backend のライフサイクル調査用に、bridge は `codex app-server` 子プロセスのローカル JSONL ログを書き出します。既定の出力先は `<DATA_DIR>/codex-app-server.jsonl` で、`CODEX_DEBUG_LOG_FILE` で変更できます。

各行には bridge インスタンス識別用の `bridgePid` と `listenPort` も入るので、複数 bridge が同じファイルへ書いていても切り分けできます。このログには `child.spawn`、`child.stderr`、`child.exit`、`child.restart.scheduled`、`turn.start.result`、`turn.finished` などのイベントが記録されます。

よく使う確認コマンド:

```bash
tail -f data/codex-app-server.jsonl
rg '"event":"child.exit"|"event":"child.stderr"|"event":"turn.finished"' data/codex-app-server.jsonl
rg '"listenPort":3210|"listenPort":3000' data/codex-app-server.jsonl
```

## 主な環境変数

| Variable | Default | Description |
| --- | --- | --- |
| `CODEX_MODE` | `auto` | 既定の起動モード。UI / backend 単体確認では `mock` を使う |
| `CODEX_HOME_DIR` | current OS user's home directory | 起動した `codex app-server` が thread 履歴を読む Codex home を上書きしたいときに使う |
| `CODEX_DEBUG_LOG_FILE` | `<DATA_DIR>/codex-app-server.jsonl` | Codex app-server のライフサイクルを記録する JSONL デバッグログ |
| `HOST` | `127.0.0.1` | bridge の listen host |
| `PORT` | `3210` | bridge の listen port |
| `REPO_CONFIG_PATH` | source checkout: `<workspace>/repos.json`; packaged: app config dir | 任意の repository preset ファイル |
| `DATA_DIR` | source checkout: `<workspace>/data`; packaged: platform app data dir | アプリデータの保存先 |
| `STATE_FILE` | `<DATA_DIR>/state.json` | push subscription と生成済み VAPID key を保存する JSON state file |
| `UPLOADS_DIR` | `<DATA_DIR>/uploads` | アップロード画像の保存先 |
| `WEB_DIST_DIR` | auto-detected bundled assets | bridge から配信する build 済み frontend |
| `WORKSPACE_ROOT` | source checkout auto-detect | workspace ルート解決を上書きしたい場合に使う |
| `MAX_PROMPT_LENGTH` | `12000` | prompt の最大文字数 |
| `MAX_IMAGE_ATTACHMENTS` | `5` | 1 run あたりの最大画像数 |
| `MAX_IMAGE_ATTACHMENT_BYTES` | `10485760` | 画像 1 枚あたりの最大バイト数 |

既存の起動 script 互換のため、`DB_FILE` も非推奨の互換入力として引き続き受け付けます。`DB_FILE` が指定された場合でも、bridge はそのパスから隣接する `.json` state file を導出し、古い SQLite file 自体は直接再利用しません。

## 動作確認

```bash
curl http://127.0.0.1:3210/healthz
curl http://127.0.0.1:3210/api/repos
```

最低限の確認ポイント:

- `healthz` で `ok: true` が返る
- `api/repos` が JSON を返る。既存の Codex thread、`repos.json` preset、current git repo fallback のいずれかで埋まる

## 構成

- `apps/bridge`: Fastify backend、Codex bridge、push 通知用の保存領域、WebSocket gateway
- `apps/web`: Vite で build する React SPA
- `packages/shared-types`: bridge と web で共有している TypeScript 型
- `docs/`: 補助的な設計メモや設計方針

## トラブルシュート

### repository が表示されない

既存の Codex thread がまだ無い場合は、`REPO_CONFIG_PATH` の `repos.json` を作成するか、現在の git repository を自動検出させるため repository 配下から起動してください。

```bash
cp repos.example.json repos.json
```

### `Configured repository path does not exist`

`repos.json` の各 `path` が実在するローカルディレクトリを指しているか確認してください。

### bridge が mock mode にフォールバックする

Codex CLI が利用可能か確認してください。

```bash
codex --version
codex app-server --listen stdio://
```

UI と bridge の確認だけが目的なら、そのまま mock mode で進めて問題ありません。
