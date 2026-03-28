# Codex Remote Web Client

`codex_remote_web_client_v_1_5_design.md` をもとに実装した、mobile-first の Codex remote bridge + web UI です。

ローカルのリポジトリを Web UI から選択し、session 作成、prompt 送信、run 状態監視、message 履歴確認までを一通り扱えます。

## できること

- repo 一覧の表示と選択
- session 作成、一覧、検索、未読管理
- prompt 送信と run 状態管理
- WebSocket によるリアルタイム更新
- `CODEX_MODE=real` で Codex app-server 実行
- `CODEX_MODE=mock` でバックエンド単体のローカル確認

## 構成

- `apps/bridge`: Fastify + SQLite + WebSocket + Codex app-server bridge
- `apps/web`: React + Vite + TanStack Query + Zustand の UI
- `packages/shared-types`: backend / frontend 共有型

## 前提

- Node.js 20 以上
- npm
- `CODEX_MODE=real` を使う場合は `codex` CLI がローカルに入っていること

## 最短セットアップ

GitHub から clone した人がまず画面を立ち上げるだけなら、mock mode が最短です。

```bash
git clone https://github.com/ikazoy/remote-control-codex.git
cd remote-control-codex
cp repos.example.json repos.json
npm install
npm run build
CODEX_MODE=mock npm run start
```

起動後:

- Bridge + built web: [http://127.0.0.1:3000](http://127.0.0.1:3000)
- health check: [http://127.0.0.1:3000/healthz](http://127.0.0.1:3000/healthz)

## `repos.json` の準備

このアプリは操作対象 repo を `repos.json` から読み込みます。公開用には `repos.example.json` を同梱しているので、clone 後にコピーして使ってください。

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

注意:

- `path` は絶対パスでも相対パスでも使えます
- 相対パスは `repos.json` が置かれているディレクトリ基準で解決されます
- まずは `"path": "."` のままで、この clone 済み repo 自体を対象にするのが一番簡単です

## 実運用モードで起動する

Codex CLI が使える環境なら `real` mode で起動できます。

```bash
npm install
npm run build
CODEX_MODE=real npm run start
```

bridge は内部で次のコマンドを呼び出します。

```bash
codex app-server --listen stdio://
```

`real` mode で起動できない場合は、まず `mock` mode で UI / bridge 側の確認を進めてください。

## 開発用コマンド

```bash
# bridge + web dev server を同時起動
npm run dev

# production build を作成
npm run build

# build 済み web を bridge から配信
npm run start

# web 単体 dev server
npm run dev -w @codex-remote/web
```

## 環境変数

主要な設定値:

- `CODEX_MODE`: `auto` / `real` / `mock`
- `HOST`: bridge listen host。既定値は `127.0.0.1`
- `PORT`: bridge listen port。既定値は `3000`
- `REPO_CONFIG_PATH`: repo 設定ファイル。既定値は `<workspace>/repos.json`
- `DATA_DIR`: SQLite とアプリデータの格納先。既定値は `<workspace>/data`
- `DB_FILE`: SQLite DB ファイル。既定値は `<workspace>/data/remote-control.db`
- `WEB_DIST_DIR`: 配信する web build の場所。既定値は `<workspace>/apps/web/dist`
- `WORKSPACE_ROOT`: workspace の明示指定が必要な場合に利用
- `MAX_PROMPT_LENGTH`: prompt 上限。既定値は `12000`
- `MAX_CONCURRENT_RUNS`: 同時 run 数。既定値は `1`

例:

```bash
PORT=3100 CODEX_MODE=mock npm run start
```

## 動作確認

起動後に最低限見る項目:

```bash
curl http://127.0.0.1:3000/healthz
curl "http://127.0.0.1:3000/api/repos"
```

確認ポイント:

- `healthz` で `ok: true`
- `api/repos` で `repos.json` の内容が返る
- Web UI で session 作成と message 送信ができる
- `CODEX_MODE=real` の場合は run 完了後に assistant message が保存される

## トラブルシュート

### `Repository config not found` で起動失敗する

`repos.example.json` を `repos.json` にコピーしてから起動してください。

```bash
cp repos.example.json repos.json
```

### `Configured repository path does not exist` が出る

`repos.json` の `path` が実在するローカルディレクトリを指しているか確認してください。

### `CODEX_MODE=real` で backend が ready にならない

`codex` CLI が使えるか確認してください。

```bash
codex --version
codex app-server --listen stdio://
```

難しい場合はいったん `CODEX_MODE=mock` で立ち上げれば、bridge / UI 側の確認は進められます。

### 画面は出るがリアルタイム更新されない

bridge が配信している [http://127.0.0.1:3000](http://127.0.0.1:3000) を開いて確認してください。`vite` の dev server を別で使っているときは、確認対象を混同しない方が安全です。

## 確認済み

- `GET /healthz`
- `GET /api/repos`
- session 作成
- run 開始
- Codex app-server 実行完了の保存
- unread badge の read 化
- WebSocket 接続
- mobile layout での session -> chat 遷移
