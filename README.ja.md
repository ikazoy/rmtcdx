# Codex Remote Web Client

[English](./README.md) | [日本語](./README.ja.md)

Codex Remote Web Client は、mobile-first の Web UI から OpenAI Codex CLI をリモート操作するためのアプリです。ローカルリポジトリを選択し、session を作成して prompt を送り、run の進行をリアルタイムに追い、message 履歴を 1 つの画面で確認できます。

## できること

- `npx remote-control-codex` / `bunx remote-control-codex` で one-command 起動できる
- Codex thread から見つけた repository、任意の `repos.json` preset、現在の git working tree fallback を一覧表示できる
- session 一覧の検索、filter、未読管理、rename、archive
- 画像添付付き prompt の送信
- WebSocket による run 状態と message のリアルタイム更新
- ブラウザ push 通知と Codex 利用量表示
- session list と chat を行き来しやすい mobile-first レイアウト

## 前提

- Node.js 20 以上
- npm または bun
- Codex と接続して動かす場合はローカルに `codex` CLI が入っていること

## One-Command Start

```bash
npx remote-control-codex
# または
bunx remote-control-codex
```

`repos.json` がなくても、起動したカレントディレクトリが git repository 配下なら、その repository を pinned entry として自動で使えます。

複数 repository を永続的に登録したい場合は、app config directory に `repos.json` を作成してください。

- macOS: `~/Library/Application Support/remote-control-codex/repos.json`
- Linux: `~/.config/remote-control-codex/repos.json`
- Windows: `%APPDATA%\\remote-control-codex\\repos.json`

state の保存先も source tree の外です。

- macOS: `~/Library/Application Support/remote-control-codex`
- Linux: `~/.local/share/remote-control-codex`
- Windows: `%LOCALAPPDATA%\\remote-control-codex`

## 永続化する state

bridge がローカルに保持する server-owned state は最小限です。

- `state.json`: push subscription と生成済み VAPID key
- `uploads/`: web client から送った画像添付
- `codex-app-server.jsonl`: 任意の bridge デバッグログ

session / message 履歴、thread title、archive 状態、run 履歴は `codex app-server` 越しに Codex thread からその都度読みます。bridge 側でそれらをローカル DB に複製しません。

## Source Checkout

```bash
git clone https://github.com/ikazoy/remote-control-codex.git
cd remote-control-codex
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

別ネットワークから入る場合は、bridge を localhost bind のままにして、Tailscale Serve で tailnet 内に公開するのを推奨します。

```bash
npx remote-control-codex &
tailscale serve --bg 3210
```

source checkout から起動する場合は、代わりに `PORT=3210 npm run start &` でも同じです。

その後、この node の Serve URL を開きます。例:

- `https://mac-mini-1.stingray-newton.ts.net/`

よく使うコマンド:

```bash
tailscale serve status
tailscale serve off
```

ポイント:

- このアプリは `/api` と `/ws` を相対パスで使うので、同じ Serve URL 経由で UI と WebSocket の両方が動きます
- `tailscale serve --bg 3210` は、停止するまで reboot や Tailscale 再起動後も維持されます
- 初回に `Serve is not enabled on your tailnet` と出た場合は、コマンドが表示する admin URL を一度開いて node で Serve を有効化し、その後で再実行してください
- ポート 3000 は開発サーバー (`npm run dev`) 用に予約されています

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
    "name": "remote-control-codex",
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

個別ワークスペース用コマンド:

```bash
npm run dev -w remote-control-codex
npm run dev -w @codex-remote/web
npm run build -w remote-control-codex
npm run build -w @codex-remote/web
```

### package 化した起動経路のローカル確認

`npm publish` 前に、生成した tarball から `npx remote-control-codex` 相当の経路を確認できます。

```bash
npm pack -w remote-control-codex
TMP_DIR="$(mktemp -d)"
PORT=33210 HOST=127.0.0.1 CODEX_MODE=mock \
REPO_CONFIG_PATH="$TMP_DIR/repos.json" \
DATA_DIR="$TMP_DIR/data" \
npm_config_cache="$TMP_DIR/npm-cache" \
npx --yes --package ./remote-control-codex-0.1.0.tgz remote-control-codex
```

別ターミナルで:

```bash
curl http://127.0.0.1:33210/healthz
curl http://127.0.0.1:33210/api/repos
```

片付けるときは:

```bash
rm -rf "$TMP_DIR" ./remote-control-codex-0.1.0.tgz
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
