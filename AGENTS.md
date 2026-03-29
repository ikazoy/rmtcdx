# AGENTS.md

## Project Overview

Codex Remote Web Client — mobile-first の Web UI から OpenAI Codex CLI をリモート操作するアプリケーション。
ローカルリポジトリの選択、session 管理、prompt 送信、run 監視、message 履歴確認を提供する。

## Tech Stack

- **Runtime**: Node.js >= 20, npm workspaces
- **Language**: TypeScript (ES2022, strict mode)
- **Backend** (`apps/bridge`): Fastify 5, better-sqlite3, WebSocket, Zod 4, pino
- **Frontend** (`apps/web`): React 19, Vite, TanStack Query, Zustand, React Router
- **Shared types** (`packages/shared-types`): backend / frontend 共有の型定義

## Project Structure

```
remote-control-codex/
├── apps/
│   ├── bridge/          # Fastify backend (REST + WebSocket + Codex bridge)
│   └── web/             # React SPA (Vite)
├── packages/
│   └── shared-types/    # 共有 TypeScript 型
├── repos.json           # 操作対象リポジトリ設定 (gitignore 対象)
├── repos.example.json   # repos.json のテンプレート
├── tsconfig.base.json   # 共通 TypeScript 設定
└── package.json         # workspace root
```

## Build & Dev Commands

```bash
# 依存インストール
npm install

# bridge + web を同時開発
npm run dev

# production build (bridge → web の順)
npm run build

# build 済みアプリを起動
npm run start                       # CODEX_MODE=auto (default)
CODEX_MODE=mock npm run start       # mock mode
CODEX_MODE=real npm run start       # Codex CLI 必須

# 個別ワークスペース
npm run dev -w @codex-remote/bridge
npm run dev -w @codex-remote/web
npm run build -w @codex-remote/bridge
npm run build -w @codex-remote/web
```

## Key Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CODEX_MODE` | `auto` | `auto` / `real` / `mock` |
| `PORT` | `3000` | bridge listen port |
| `HOST` | `127.0.0.1` | bridge listen host |
| `REPO_CONFIG_PATH` | `<workspace>/repos.json` | repo config file |
| `DATA_DIR` | `<workspace>/data` | app data directory |
| `DB_FILE` | `<workspace>/data/remote-control.db` | SQLite DB file |
| `MAX_PROMPT_LENGTH` | `12000` | prompt 文字数上限 |
| `MAX_IMAGE_ATTACHMENTS` | `5` | 1 run あたりの画像数上限 |
| `MAX_IMAGE_ATTACHMENT_BYTES` | `10485760` | 画像 1 枚あたりの最大サイズ |

## Code Conventions

- ESM (`"type": "module"`) を全パッケージで使用
- TypeScript strict mode (`strict: true`, `noUncheckedIndexedAccess: true`)
- backend の dev は `tsx watch`、build は `tsup`
- frontend の build は `vite build`
- 日本語コメント・ドキュメント OK

## Documentation Notes

- top-level README は `README.md` と `README.ja.md` の 2 つを運用する
- `README.md` は GitHub 既定表示用の英語版、`README.ja.md` は日本語版
- セットアップ手順や機能一覧を更新するときは両方を同期して更新する

## Architecture Notes

- bridge は Codex CLI (`codex app-server --listen stdio://`) を子プロセスとして起動し stdio で通信する
- SQLite でセッション・メッセージを永続化
- WebSocket でフロントエンドへリアルタイム push
- `repos.json` からリポジトリ一覧を読み込む（`repos.example.json` をコピーして作成）
