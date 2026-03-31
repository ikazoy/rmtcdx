# Codex Remote Web Client

[English](./README.md) | [日本語](./README.ja.md)

Codex Remote Web Client is a mobile-first web UI for remotely operating OpenAI Codex CLI from your browser. It lets you choose a local repository, create and revisit sessions, send prompts, follow runs in real time, and review message history from one interface.

## Features

- One-command launch via `npx rmtcdx` or `bunx rmtcdx`
- Repository picker built from discovered Codex threads, optional `repos.json` presets, and the current git working tree fallback
- Session list with search, filters, unread state, rename, and archive
- Prompt submission with optional image attachments
- Live run updates and message streaming over WebSocket
- Browser push notifications and Codex usage-limit status
- Mobile-first layout for moving between the session list and chat view

## Requirements

- Node.js 20 or newer
- npm or bun
- `codex` CLI installed locally if you want the bridge to drive a live Codex backend

## One-Command Start

```bash
npx rmtcdx up
# or
bunx rmtcdx up
```

This starts `rmtcdx` in the background, prints a local URL, prints a same-network URL when a private IPv4 address is available, and tells you how to enable Tailscale access for your phone outside your network.

To stop the background process later:

```bash
npx rmtcdx stop
```

To inspect the current runtime status:

```bash
npx rmtcdx status
```

Running `npx rmtcdx` without a subcommand is treated as `npx rmtcdx up`.

If `repos.json` is missing and your current working directory is inside a git repository, the app automatically exposes that repository as a pinned entry.

For a persistent multi-repo setup, create `repos.json` in the app config directory:

- macOS: `~/Library/Application Support/rmtcdx/repos.json`
- Linux: `~/.config/rmtcdx/repos.json`
- Windows: `%APPDATA%\\rmtcdx\\repos.json`

State is stored outside the source tree as well:

- macOS: `~/Library/Application Support/rmtcdx`
- Linux: `~/.local/share/rmtcdx`
- Windows: `%LOCALAPPDATA%\\rmtcdx`

## Persisted State

The bridge keeps only a small amount of server-owned state on disk:

- `state.json` stores push subscriptions and generated VAPID keys
- `uploads/` stores image attachments uploaded from the web client
- `codex-app-server.jsonl` stores optional bridge debug logs

Session and message history, thread titles, archive state, and run history are read live from Codex threads through `codex app-server`. The bridge does not duplicate that catalog into a local database.

## Source Checkout

```bash
git clone https://github.com/ikazoy/rmtcdx.git
cd rmtcdx
npm install
npm run build
# Optional: pre-seed the repository picker for an empty-state setup
cp repos.example.json repos.json
PORT=3210 npm run start
```

`npm run start` uses `CODEX_MODE=auto` by default. If the `codex` CLI is available, the bridge connects to it. If not, it falls back to mock mode.

If `repos.json` is missing, the app still starts. In that case, the repository picker is built from existing Codex threads. If you have no existing threads yet, starting inside a git repository or copying `repos.example.json` is the easiest way to seed the first workspace.

After startup:

- App: [http://127.0.0.1:3210](http://127.0.0.1:3210)
- Health check: [http://127.0.0.1:3210/healthz](http://127.0.0.1:3210/healthz)

## Remote Access over Tailscale

If you want to connect to Codex from your phone outside your network, start `rmtcdx` with the built-in Tailscale option:

```bash
npx rmtcdx up --tailscale
```

This checks that `tailscale` is installed and ready before startup. If that preflight fails, `rmtcdx` does not stay running in the background.

To stop both the background bridge and restore the previous Tailscale Serve configuration:

```bash
npx rmtcdx stop
```

Notes:

- `rmtcdx up` binds to `0.0.0.0` so the same-network URL it prints is reachable from another device on your LAN
- This app uses relative `/api` and `/ws` paths, so the UI and WebSocket updates work through the same Tailscale URL
- `rmtcdx` backs up the previous Tailscale Serve config before enabling its proxy and restores that backup on `rmtcdx stop`
- If Tailscale prints `Serve is not enabled on your tailnet`, open the admin URL shown by the command once, enable Serve for the node, and run `npx rmtcdx up --tailscale` again
- Port 3000 is reserved for the dev server (`npm run dev`)

Full CLI details: [docs/cli.md](./docs/cli.md)

## Configure `repos.json`

`repos.json` is optional. In a source checkout the default path is `<workspace>/repos.json`. In packaged usage it lives in the app config directory shown above.

When present, the bridge uses it to pre-seed the repository picker and override repository labels, descriptions, and pinned state. Without `repos.json`, the app discovers repositories from existing Codex threads. If you are starting from a completely empty Codex history, adding `repos.json` or launching from inside the target git repository is the easiest way to make the first workspace selectable.

To add presets, start by copying the example file:

```bash
cp repos.example.json repos.json
```

Example:

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

Notes:

- `path` can be absolute or relative
- Relative paths are resolved from the directory that contains `repos.json`
- Keeping `"path": "."` is the easiest way to point the app at the cloned repository itself
- If `repos.json` is missing, starting the app from inside a git repository adds that repository automatically

## Development

Run the bridge and web app together during development:

```bash
npm run dev
```

Workspace-specific commands:

```bash
npm run dev -w rmtcdx
npm run dev -w @codex-remote/web
npm run build -w rmtcdx
npm run build -w @codex-remote/web
```

### Local Package Smoke Test

Before `npm publish`, you can verify the packaged `npx rmtcdx` path from the generated tarball:

```bash
npm pack -w rmtcdx
TMP_DIR="$(mktemp -d)"
PORT=33210 HOST=127.0.0.1 CODEX_MODE=mock \
REPO_CONFIG_PATH="$TMP_DIR/repos.json" \
DATA_DIR="$TMP_DIR/data" \
npm_config_cache="$TMP_DIR/npm-cache" \
npx --yes --package ./rmtcdx-0.1.0.tgz rmtcdx up
```

In another terminal:

```bash
curl http://127.0.0.1:33210/healthz
curl http://127.0.0.1:33210/api/repos
```

Cleanup:

```bash
rm -rf "$TMP_DIR" ./rmtcdx-0.1.0.tgz
```

Stop the running bridge with `Ctrl+C` before removing the temp directory.

### Mock Mode

Use mock mode when you want to work on the UI or bridge without a working Codex CLI:

```bash
CODEX_MODE=mock npm run start
```

### Codex app-server Debug Log

For real-backend lifecycle debugging, the bridge writes a local JSONL log for the `codex app-server` child process. The default path is `<DATA_DIR>/codex-app-server.jsonl`, and you can override it with `CODEX_DEBUG_LOG_FILE`.

Each line includes the bridge instance metadata (`bridgePid`, `listenPort`) so mixed logs from multiple bridge processes can be separated. The log records lifecycle and correlation events such as `child.spawn`, `child.stderr`, `child.exit`, `child.restart.scheduled`, `turn.start.result`, and `turn.finished`.

Useful commands:

```bash
tail -f data/codex-app-server.jsonl
rg '"event":"child.exit"|"event":"child.stderr"|"event":"turn.finished"' data/codex-app-server.jsonl
rg '"listenPort":3210|"listenPort":3000' data/codex-app-server.jsonl
```

## Key Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `CODEX_MODE` | `auto` | Default startup mode. Set `mock` for UI/backend-only development |
| `CODEX_DEBUG_LOG_FILE` | `<DATA_DIR>/codex-app-server.jsonl` | JSONL debug log for Codex app-server lifecycle |
| `HOST` | `127.0.0.1` | Bridge listen host |
| `PORT` | `3210` | Bridge listen port |
| `REPO_CONFIG_PATH` | source checkout: `<workspace>/repos.json`; packaged: app config dir | Optional repository preset file |
| `DATA_DIR` | source checkout: `<workspace>/data`; packaged: platform app data dir | Application data directory |
| `STATE_FILE` | `<DATA_DIR>/state.json` | JSON state file used for push subscriptions and generated VAPID keys |
| `UPLOADS_DIR` | `<DATA_DIR>/uploads` | Uploaded image storage |
| `WEB_DIST_DIR` | auto-detected bundled assets | Built frontend served by the bridge |
| `WORKSPACE_ROOT` | source checkout auto-detect | Override workspace root resolution |
| `MAX_PROMPT_LENGTH` | `12000` | Maximum prompt length |
| `MAX_IMAGE_ATTACHMENTS` | `5` | Maximum images per run |
| `MAX_IMAGE_ATTACHMENT_BYTES` | `10485760` | Maximum size in bytes for a single image |

`DB_FILE` is still accepted as a deprecated compatibility input. When it is set, the bridge derives a sibling `.json` state file from that path instead of reusing the old SQLite file directly.

## Verify The Bridge

```bash
curl http://127.0.0.1:3210/healthz
curl http://127.0.0.1:3210/api/repos
```

You should see:

- `ok: true` from `healthz`
- A JSON response from `api/repos`; it can be populated by discovered Codex threads, `repos.json` presets, or the current git repo fallback

## Project Structure

- `apps/bridge`: Fastify backend, Codex bridge, push-notification storage, and WebSocket gateway
- `apps/web`: React SPA built with Vite
- `packages/shared-types`: shared TypeScript types used by bridge and web
- `docs/`: supporting design and architecture notes

## Troubleshooting

### No repositories appear

If you do not have any existing Codex threads yet, create `repos.json` at `REPO_CONFIG_PATH` or start the app from inside a git repository so the current working tree is inferred automatically.

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
