# CLI update command design

この文書は、[docs/cli.ja.md](./cli.ja.md) で定義している end-user CLI に対して、upgrade / rollback 用の明示コマンドを追加する設計案です。

## 背景

現在の `rmtcdx` CLI は次のコマンドだけを持っています。

- `rmtcdx up`
- `rmtcdx up --tailscale`
- `rmtcdx stop`
- `rmtcdx status`

この構成は小さくて分かりやすい一方で、upgrade / rollback は利用者が `npx rmtcdx@latest up` や `npx rmtcdx@0.1.0 up` を直接打つ前提になっています。

また、実装上の制約もあります。

- `rmtcdx up` は既に動いている background bridge を見つけると、その process を再利用して終了する
- `npx` / `npm exec` は「その invocation で使う package を解決して実行する」仕組みであり、今動いている bin script 自体をその場で書き換えるものではない

そのため、「bin script の中で自動アップデートする」は in-place self-update ではなく、「別 version へ明示的に handoff する」設計として扱うのが自然です。

## Goals

- 利用者が 1 コマンドで安定版へ追従できるようにする
- exact version への rollback を簡単で予測可能にする
- 既存 runtime の Tailscale 状態を、利用者が明示しない限り引き継ぐ
- 通常の `up` はネットワーク依存を増やさず deterministic に保つ
- npm の package spec / dist-tag の意味とずれない UX にする

## Non-goals

- 毎回の `up` で silent に update check すること
- 現在実行中の package をその場で自己書換えすること
- bridge を止めずに裏で自動アップデートすること
- npm registry 以外まで含む汎用 package manager abstraction

## 提案コマンド

### `rmtcdx check-update`

現在の CLI version と registry 上の `latest` を比較する read-only command です。

出力内容:

- current CLI version
- current `latest` version
- update があるかどうか
- upgrade 用の実行コマンド
- 現在版へ戻す rollback 用の実行コマンド

例:

```bash
npx rmtcdx check-update
```

```text
Current: 0.1.0
Latest: 0.1.2
Update available.
Upgrade: npx rmtcdx update
Rollback: npx rmtcdx update --to 0.1.0
```

### `rmtcdx update`

実行中の bridge を別の publish 済み version に切り替える明示コマンドです。

既定 target:

- `latest`

例:

```bash
npx rmtcdx update
```

```bash
npx rmtcdx update --to 0.1.0
```

```bash
npx rmtcdx update --to next
```

## Flags

### `--to <tag-or-version>`

handoff 先の package target を指定します。

受け付ける値:

- `0.1.0` のような exact version
- `latest` や `next` のような dist-tag

内部的には `rmtcdx@<tag-or-version>` として扱います。

### `--tailscale`

再起動後の version を Tailscale 有効で起動します。

### `--no-tailscale`

再起動後の version を Tailscale 無効で起動します。

どちらも指定しない場合、既に bridge が動いていればその Tailscale 状態を引き継ぎ、停止中なら無効を既定値にします。

## コマンド仕様

### `check-update`

`check-update` の処理:

1. 自分自身の `package.json` から current version を読む
2. npm registry に対して `rmtcdx@latest` を問い合わせる
3. 人が読める形で結果を表示する
4. 成功時は `0`、lookup 失敗時は `1` で終了する

runtime state を変更したり、bridge を停止したりしてはいけません。

### `update`

`update` の処理:

1. current CLI version を読む
2. `--to` または `latest` から target version を解決する
3. runtime state があれば読む
4. 次の Tailscale 状態を決める
   - 明示 flag が最優先
   - それ以外は現在の runtime 状態を引き継ぐ
   - それも無ければ無効
5. 実行中 version が既に target version で、かつ Tailscale 状態も一致していれば no-op として `0` で終了する
6. bridge が動いていれば停止する
7. target version の `up` に handoff する
8. handoff 先 command の終了 code をそのまま返す

## Handoff Strategy

現在の package file を上書きしようとしてはいけません。

代わりに、target version を明示した `npx` を起動します。

```bash
npx --yes --prefer-online rmtcdx@<target> up
```

Tailscale を有効にする場合:

```bash
npx --yes --prefer-online rmtcdx@<target> up --tailscale
```

理由:

- package spec、tag、cache の扱いは `npx` に任せるのが自然
- `--prefer-online` を付けることで `latest` の stale cache を減らせる
- exact version による rollback もそのまま使える

## Runtime State の拡張

`status` と `update` を正しく動かすため、runtime state には background bridge を起動した version を保存する必要があります。

追加フィールド:

```ts
version: string
```

これは `up` が書き込み、`status` が表示します。

## `status` の出力拡張

`rmtcdx status` は次を追加表示します。

- `Version: <version>`

これが無いと、「今実行している CLI は新しいが、background では古い bridge が生きている」という状態を判別できません。

## Failure Behavior

### Registry lookup failure

- `check-update` は network / registry error を明示して失敗する
- `update` は target version を解決できない限り stop まで進まない

### stop 後の handoff failure

bridge を止めた後に handoff が失敗した場合、`update` は次を行います。

- 失敗した target version を表示する
- current version に戻す recovery command を表示する
- non-zero で終了する

例:

```text
Update failed while starting 0.1.2.
Recovery: npx rmtcdx@0.1.0 up
```

自動 rollback はしません。失敗原因が package version ではなく、ネットワークやローカル環境差分である可能性もあるので、ここで暗黙 rollback を入れると挙動が読みにくくなります。

## User Guidance

利用者向けの導線は明示的なままにします。

- 通常 upgrade: `npx rmtcdx update`
- 手動 stable 起動: `npx rmtcdx@latest up`
- exact rollback: `npx rmtcdx update --to 0.1.0`
- 手動 exact rollback: `npx rmtcdx stop && npx rmtcdx@0.1.0 up`

これなら npm の package spec / dist-tag の意味と docs の説明が揃います。

## Maintainer 側との関係

この設計は次を前提にします。

- 安定版は `latest` dist-tag を進める
- bad release が出たら `latest` を直前の good version に戻す
- 問題のある version は npm で deprecate できる

これにより `rmtcdx update` は常に stable stream を追い、`--to <version>` は escape hatch として残せます。

## Future Work

- `check-update --json`
- 明示要求時の `status` からの update available 表示
- `bunx` handoff の launcher detection
- `latest` 以外の prerelease channel の運用指針
