# Codex Remote Web Client

[English](./README.md) | [日本語](./README.ja.md)

Codex Remote Web Client は、mobile-first の Web UI から OpenAI Codex CLI をリモート操作するためのアプリです。ローカルリポジトリを選択し、session を作成して prompt を送り、run の進行をリアルタイムに追い、message 履歴を 1 つの画面で確認できます。

## できること

- Codex thread から見つけた repository を一覧表示し、必要なら `repos.json` で preset を足せる
- session 一覧の検索、filter、未読管理、rename、archive
- 画像添付付き prompt の送信
- WebSocket による run 状態と message のリアルタイム更新
- ブラウザ push 通知と Codex 利用量表示
- session list と chat を行き来しやすい mobile-first レイアウト

## 前提

- Node.js 20 以上
- npm
- Codex と接続して動かす場合はローカルに `codex` CLI が入っていること

## 現在の配布形態

現時点での正式な起動方法は、この repository を clone して source checkout から起動する形です。

## Quick Start

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

`repos.json` が無くてもアプリは起動します。その場合の repository picker は、既存の Codex thread から自動で作られます。まだ thread が 1 件も無い場合は、`repos.example.json` をコピーして最初の workspace を用意するのが一番簡単です。

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

`repos.json` は任意です。ファイルがある場合、bridge はそれを使って repository picker を先に埋めたり、表示名、description、pinned 状態を上書きしたりします。

`repos.json` が無い場合、アプリは既存の Codex thread から repository を見つけて表示します。Codex の履歴が完全に空の状態から始めるなら、`repos.json` を追加するのが最も簡単です。

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
| `REPO_CONFIG_PATH` | `<workspace>/repos.json` | 任意の repository preset ファイル |
| `DATA_DIR` | `<workspace>/data` | アプリデータの保存先 |
| `DB_FILE` | `<workspace>/data/remote-control.db` | push subscription と notification 設定を保存する SQLite DB |
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
- `api/repos` が JSON を返る。既存 thread も `repos.json` も無い場合、`repos` は空でも正常

## 構成

- `apps/bridge`: Fastify backend、Codex bridge、push 通知用の保存領域、WebSocket gateway
- `apps/web`: Vite で build する React SPA
- `packages/shared-types`: bridge と web で共有している TypeScript 型
- `docs/`: 補助的な設計メモや設計方針

## トラブルシュート

### repository picker が空のまま

既存の Codex thread がまだ無い場合は、テンプレートから `repos.json` を作って最初の workspace を用意してください。

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
