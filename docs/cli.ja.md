# CLI

`rmtcdx` には、バックグラウンド bridge の起動、停止、状態確認のための小さな end-user CLI が入っています。

## Commands

### `rmtcdx up`

bridge をバックグラウンドで起動します。

起動後は次を表示します。

- `Local: http://127.0.0.1:<port>`
- private IPv4 が見つかった場合の `Phone on the same network: http://<private-ip>:<port>`
- 外からスマホで Codex につなぎたいときの `rmtcdx up --tailscale` 案内

`rmtcdx up` は same-network URL が macOS / Windows の両方で使えるように `0.0.0.0` bind で起動します。

subcommand なしの `rmtcdx` は `rmtcdx up` と同じです。

### `rmtcdx up --tailscale`

bridge をバックグラウンドで起動し、Tailscale Serve で公開します。

挙動:

- 起動前に `tailscale` が入っていて利用可能か確認する
- Tailscale preflight に失敗したら起動したままにしない
- proxy を有効化する前に現在の Tailscale Serve 設定をバックアップする
- `rmtcdx stop` でそのバックアップ設定に戻す

### `rmtcdx stop`

バックグラウンド bridge process を停止します。

`--tailscale` 付きで起動していた場合は、起動時に保存した以前の Tailscale Serve 設定も復元します。

### `rmtcdx status`

現在の runtime 状態を表示します。内容は次の通りです。

- local URL
- 取得できた場合の same-network URL
- 有効な場合の Tailscale URL

## Source Checkout

開発や source checkout 用には、引き続き foreground 起動もできます。

```bash
npm run start
```

この経路は内部の `serve` command を使い、daemon 化しません。

関連設計: [CLI update command design](./cli-update-design.ja.md)
