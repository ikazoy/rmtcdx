# CLI

`rmtcdx` ships with a small end-user CLI for starting, stopping, and checking the background bridge.

## Commands

### `rmtcdx up`

Starts the bridge in the background.

After startup, it prints:

- `Local: http://127.0.0.1:<port>`
- `Phone on the same network: http://<private-ip>:<port>` when a private IPv4 address is available
- guidance for `rmtcdx up --tailscale` when you want to connect to Codex from your phone outside your network

`rmtcdx up` binds the server to `0.0.0.0` so the same-network URL works on both macOS and Windows.

Running `rmtcdx` without a subcommand is the same as `rmtcdx up`.

### `rmtcdx up --tailscale`

Starts the bridge in the background and publishes it with Tailscale Serve.

Behavior:

- verifies that `tailscale` is installed and ready before startup
- refuses to stay running if the Tailscale preflight fails
- backs up the current Tailscale Serve configuration before enabling the proxy
- restores that saved config on `rmtcdx stop`

### `rmtcdx stop`

Stops the background bridge process.

If the bridge was started with `--tailscale`, this also restores the previous Tailscale Serve configuration that was backed up at startup time.

### `rmtcdx status`

Prints the current runtime status, including:

- local URL
- same-network URL when available
- Tailscale URL when enabled

## Source Checkout

The app still supports foreground startup for development and source checkouts:

```bash
npm run start
```

That path uses the internal `serve` command and does not daemonize the process.
