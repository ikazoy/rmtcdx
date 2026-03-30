# Codex Remote Web Client

[English](./README.md) | [日本語](./README.ja.md)

Codex Remote Web Client は、mobile-first の Web UI から OpenAI Codex CLI をリモート操作するためのアプリです。ローカルリポジトリを選択し、session を作成して prompt を送り、run の進行をリアルタイムに追い、message 履歴を 1 つの画面で確認できます。

## できること

- `repos.json` に定義したローカル workspace を選択できる
- session 一覧の検索、filter、未読管理、rename、archive
- 画像添付付き prompt の送信
- WebSocket による run 状態と message のリアルタイム更新
- SQLite による session と message の永続化
- session list と chat を行き来しやすい mobile-first レイアウト

## 前提

- Node.js 20 以上
- npm
- Codex と接続して動かす場合はローカルに `codex` CLI が入っていること

## Quick Start

```bash
git clone https://github.com/ikazoy/remote-control-codex.git
cd remote-control-codex
cp repos.example.json repos.json
npm install
npm run build
PORT=3210 npm run start
```

`npm run start` は既定で `CODEX_MODE=auto` を使います。`codex` CLI が利用できれば bridge はそれに接続し、利用できない場合は自動で mock mode にフォールバックします。

起動後:

- App: [http://127.0.0.1:3210](http://127.0.0.1:3210)
- Health check: [http://127.0.0.1:3210/healthz](http://127.0.0.1:3210/healthz)

## Tailscale 経由で別ネットワークから使う

別ネットワークから入る場合は、bridge を localhost bind のままにして、Tailscale Serve で tailnet 内に公開するのを推奨します。

```bash
npm run build
PORT=3210 npm run start &
tailscale serve --bg 3210
```

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

bridge は操作対象リポジトリの一覧を `repos.json` から読み込みます。まずはテンプレートをコピーしてください。

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

## 開発

開発時に bridge と web を同時に起動するには:

```bash
npm run dev
```

個別ワークスペース用コマンド:

```bash
npm run dev -w @codex-remote/bridge
npm run dev -w @codex-remote/web
npm run build -w @codex-remote/bridge
npm run build -w @codex-remote/web
```

### Mock Mode

Codex CLI を使わずに UI や bridge の動作確認をしたい場合は mock mode を使います。

```bash
CODEX_MODE=mock npm run start
```

### Codex app-server デバッグログ

real backend のライフサイクル調査用に、bridge は `codex app-server` 子プロセスのローカル JSONL ログを書き出します。既定の出力先は `data/codex-app-server.jsonl` で、`CODEX_DEBUG_LOG_FILE` で変更できます。

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
| `CODEX_DEBUG_LOG_FILE` | `<workspace>/data/codex-app-server.jsonl` | Codex app-server のライフサイクルを記録する JSONL デバッグログ |
| `HOST` | `127.0.0.1` | bridge の listen host |
| `PORT` | `3210` | bridge の listen port |
| `REPO_CONFIG_PATH` | `<workspace>/repos.json` | repo 一覧ファイル |
| `DATA_DIR` | `<workspace>/data` | アプリデータの保存先 |
| `DB_FILE` | `<workspace>/data/remote-control.db` | SQLite DB ファイル |
| `UPLOADS_DIR` | `<workspace>/data/uploads` | アップロード画像の保存先 |
| `WEB_DIST_DIR` | `<workspace>/apps/web/dist` | bridge から配信する build 済み frontend |
| `WORKSPACE_ROOT` | auto-detected | workspace ルート解決を上書きしたい場合に使う |
| `MAX_PROMPT_LENGTH` | `12000` | prompt の最大文字数 |
| `MAX_IMAGE_ATTACHMENTS` | `5` | 1 run あたりの最大画像数 |
| `MAX_IMAGE_ATTACHMENT_BYTES` | `10485760` | 画像 1 枚あたりの最大バイト数 |

## 動作確認

```bash
curl http://127.0.0.1:3210/healthz
curl http://127.0.0.1:3210/api/repos
```

最低限の確認ポイント:

- `healthz` で `ok: true` が返る
- `api/repos` で `repos.json` に定義した repo 一覧が返る

## 構成

- `apps/bridge`: Fastify backend、SQLite 永続化、WebSocket gateway、Codex bridge
- `apps/web`: Vite で build する React SPA
- `packages/shared-types`: bridge と web で共有している TypeScript 型
- `docs/`: 補助的な設計メモや設計方針

## トラブルシュート

### `Repository config not found`

テンプレートから `repos.json` を作成してください。

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
