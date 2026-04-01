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
- merge 前に `CI` を通します。
- PR template を使い、release impact を PR 本文に書きます。

## ローカル gate

`npm install` 時に `.githooks` の local git hook を設定します。

- `pre-commit`: staged 済みの `apps/` / `packages/` 配下の TypeScript / `.mjs` だけを ESLint
- `pre-push`: `npm run release:verify` を実行

この分離で、commit は重くしすぎず、CI で確実に落ちる変更は push 前に止めます。

意図的に bypass したい場合だけ、その push に限って `SKIP_PRE_PUSH=1` を使ってください。

次のような変更では、PR に release impact を書きます。

- CLI の挙動変更
- bridge や同梱 web UI の挙動変更
- install、起動、upgrade、rollback、互換性の期待値が変わる変更

通常、user-facing の release note が不要なのは次です。

- docs のみの変更
- test のみの変更
- 公開 package の挙動に影響しない CI / repo 運用のみの変更

user-facing の PR では、PR summary に短い release note draft を入れてください。

- 利用者から見て何が変わるか
- upgrade / rollback 上の注意点があるか
- additive か、挙動変更か、breaking か

## merge と release

- `main` を読みやすく保つため、merge は squash merge を推奨します。
- 通常の PR を `main` に merge した時点では publish しません。
- version bump、changelog、npm publish は、代替の自動化が入るまで手動で行います。
- publish 前に、前回 release 以降に merge された PR と release impact を見て、最終的な release note をまとめます。

入れた自動化:

- `CI`: typecheck、lint、test、packaged CLI smoke test
- local git hook: lint と pre-push の最低限の gate

## hotfix フロー

- `main` から `hotfix/<topic>` を切ります。
- review と green check の後に PR を merge します。
- fix の準備ができたら package version を手動で上げて publish します。

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
- `CI` を required status checks に設定
- `main` への直 push 制限
- squash merge の許可

## Real Codex canary

real Codex canary の runner 自体はこの repo にありますが、scheduled GitHub Actions にはまだ接続していません。CI 上での Codex CLI install と認証情報の扱いを別途決める必要があるため、現時点の release automation は packaged smoke test までに留めています。
