# Codex Remote Web Client

[English](./README.md) | [日本語](./README.ja.md)

Codex Remote Web Client is a mobile-first web UI for remotely operating OpenAI Codex CLI from your browser. It lets you choose a local repository, create and revisit sessions, send prompts, follow runs in real time, and review message history from one interface.

## Features

- Repository picker for local workspaces defined in `repos.json`
- Session list with search, filters, unread state, rename, and archive
- Prompt submission with optional image attachments
- Live run updates and message streaming over WebSocket
- SQLite-backed persistence for sessions and messages
- Mobile-first layout for moving between the session list and chat view

## Requirements

- Node.js 20 or newer
- npm
- `codex` CLI installed locally if you want the bridge to drive a live Codex backend

## Quick Start

```bash
git clone https://github.com/ikazoy/remote-control-codex.git
cd remote-control-codex
cp repos.example.json repos.json
npm install
npm run build
npm run start
```

`npm run start` uses `CODEX_MODE=auto` by default. If the `codex` CLI is available, the bridge connects to it. If not, it falls back to mock mode.

After startup:

- App: [http://127.0.0.1:3000](http://127.0.0.1:3000)
- Health check: [http://127.0.0.1:3000/healthz](http://127.0.0.1:3000/healthz)

## Configure `repos.json`

The bridge reads the list of target repositories from `repos.json`. Start by copying the example file:

```bash
cp repos.example.json repos.json
```

Example:

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

Notes:

- `path` can be absolute or relative
- Relative paths are resolved from the directory that contains `repos.json`
- Keeping `"path": "."` is the easiest way to point the app at the cloned repository itself

## Development

Run the bridge and web app together during development:

```bash
npm run dev
```

Workspace-specific commands:

```bash
npm run dev -w @codex-remote/bridge
npm run dev -w @codex-remote/web
npm run build -w @codex-remote/bridge
npm run build -w @codex-remote/web
```

### Mock Mode

Use mock mode when you want to work on the UI or bridge without a working Codex CLI:

```bash
CODEX_MODE=mock npm run start
```

## Key Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `CODEX_MODE` | `auto` | Default startup mode. Set `mock` for UI/backend-only development |
| `HOST` | `127.0.0.1` | Bridge listen host |
| `PORT` | `3000` | Bridge listen port |
| `REPO_CONFIG_PATH` | `<workspace>/repos.json` | Repository list file |
| `DATA_DIR` | `<workspace>/data` | Application data directory |
| `DB_FILE` | `<workspace>/data/remote-control.db` | SQLite database file |
| `UPLOADS_DIR` | `<workspace>/data/uploads` | Uploaded image storage |
| `WEB_DIST_DIR` | `<workspace>/apps/web/dist` | Built frontend served by the bridge |
| `WORKSPACE_ROOT` | auto-detected | Override workspace root resolution |
| `MAX_PROMPT_LENGTH` | `12000` | Maximum prompt length |
| `MAX_IMAGE_ATTACHMENTS` | `5` | Maximum images per run |
| `MAX_IMAGE_ATTACHMENT_BYTES` | `10485760` | Maximum size in bytes for a single image |

Example:

```bash
PORT=3100 npm run start
```

## Verify The Bridge

```bash
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3000/api/repos
```

You should see:

- `ok: true` from `healthz`
- The repositories defined in `repos.json` from `api/repos`

## Project Structure

- `apps/bridge`: Fastify backend, SQLite persistence, WebSocket gateway, and Codex bridge
- `apps/web`: React SPA built with Vite
- `packages/shared-types`: shared TypeScript types used by bridge and web
- `docs/`: supporting design and architecture notes

## Troubleshooting

### `Repository config not found`

Create `repos.json` from the example template:

```bash
cp repos.example.json repos.json
```

### `Configured repository path does not exist`

Check that each `path` in `repos.json` points to a real local directory.

### The bridge falls back to mock mode

Confirm that the Codex CLI is installed and callable:

```bash
codex --version
codex app-server --listen stdio://
```

If you only need to validate the UI and bridge behavior, stay in mock mode.
