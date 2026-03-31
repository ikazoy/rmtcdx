# PR と Release の運用

このリポジトリは、公開される `rmtcdx` package に影響しうる変更について、pull request ベースの運用に切り替えます。

## 目的

- `main` を常に release 可能な状態に保つ
- release note を明示的に残す
- ローカル端末ではなく GitHub Actions から npm publish する
- ユーザーにとって最新追従と固定版 rollback を両立させる

## branch ルール

- `main` は保護対象の integration branch とし、直 push しません。
- 作業は `main` から短命 branch を切って進めます。
- branch prefix の推奨:
  - `feature/<topic>`
  - `fix/<topic>`
  - `docs/<topic>`
  - `chore/<topic>`
  - `hotfix/<topic>`

## PR ルール

- `main` に入れる変更は必ず PR にします。
- 何が release されるのか判断しやすい粒度に保ちます。
- merge 前に `CI` と `Changeset Required` の両方を通します。
- PR template を使い、changeset を含めたかどうかを書きます。

次のような変更では changeset を追加します。

- CLI の挙動変更
- bridge や同梱 web UI の挙動変更
- install、起動、upgrade、rollback、互換性の期待値が変わる変更

通常、changeset が不要なのは次です。

- docs のみの変更
- test のみの変更
- 公開 package の挙動に影響しない CI / repo 運用のみの変更

changeset の作成:

```bash
npm run changeset
```

対象 package は `rmtcdx` を選び、bump level を選んで、end user 向けの要約を書きます。

## merge と release

- `main` を読みやすく保つため、merge は squash merge を推奨します。
- 通常の PR を `main` に merge した時点では publish しません。
- `Release` workflow が pending changeset から release PR を作成または更新します。
- publish したいタイミングでその release PR を merge します。
- release PR を merge すると、npm `latest` に `rmtcdx` を publish します。

入れた自動化:

- `CI`: typecheck、lint、test、packaged CLI smoke test
- `Changeset Required`: release 対象の変更で changeset 入れ忘れを block
- `Release`: version bump、changelog 更新、npm publish

## hotfix フロー

- `main` から `hotfix/<topic>` を切ります。
- patch changeset を追加します。
- review と green check の後に PR を merge します。
- 生成された release PR を merge して hotfix を publish します。

## ユーザー向け upgrade / rollback

先にバックグラウンド process を止めてください。`rmtcdx up` は既存の実行中 process を見つけるとそれを再利用します。

最新版へ更新:

```bash
npx rmtcdx stop
npx rmtcdx@latest up
```

既知の安定版へ戻す:

```bash
npx rmtcdx stop
npx rmtcdx@0.1.0 up
```

maintainer 側では bad release が出た場合、unpublish ではなく `latest` を last-known-good に戻し、問題版を `deprecate` する運用を基本にします。

## ローカル release 確認

CI と同じ packaged smoke test:

```bash
npm run smoke:package
```

release 前のフル確認:

```bash
npm run release:verify
```

## GitHub 側で有効化する設定

この運用を実際に強制するには、repository settings でも次を有効化してください。

- `main` の branch protection
- PR 必須
- `CI` と `Changeset Required` を required status checks に設定
- `main` への直 push 制限
- squash merge の許可

## Real Codex canary

real Codex canary の runner 自体はこの repo にありますが、scheduled GitHub Actions にはまだ接続していません。CI 上での Codex CLI install と認証情報の扱いを別途決める必要があるため、現時点の release automation は packaged smoke test までに留めています。
