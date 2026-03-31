# Contributing

This repository uses a pull-request-based workflow.

- English: [docs/pr-and-release-workflow.md](./docs/pr-and-release-workflow.md)
- 日本語: [docs/pr-and-release-workflow.ja.md](./docs/pr-and-release-workflow.ja.md)

Do not push directly to `main`. Open a branch, send a pull request, and include a changeset when the published `rmtcdx` package changes for users.

Local git hooks are installed from `.githooks` by `npm install`.

- `pre-commit`: lints staged `apps/` and `packages/` TypeScript or `.mjs` files
- `pre-push`: runs `npm run release:verify`

Set `SKIP_PRE_PUSH=1` only when you explicitly need to bypass the local gate.
