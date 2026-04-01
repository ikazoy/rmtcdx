# PR and Release Workflow

This repository now uses a pull-request-based workflow for all changes that can affect the published `rmtcdx` package.

## Goals

- keep `main` releasable
- make release notes explicit
- publish to npm from GitHub Actions instead of local machines
- give users a simple upgrade path and an exact-version rollback path

## Branch Rules

- `main` is the protected integration branch. Do not push to it directly.
- Create short-lived topic branches from `main`.
- Recommended branch prefixes:
  - `feature/<topic>`
  - `fix/<topic>`
  - `docs/<topic>`
  - `chore/<topic>`
  - `hotfix/<topic>`

## Pull Request Rules

- Open a PR for every change that should land in `main`.
- Keep the PR focused enough that the release impact is obvious.
- Wait for `CI` to pass before merging.
- Use the PR template and describe the release impact in the PR body.

## Local Gates

`npm install` configures local git hooks through `.githooks`.

- `pre-commit` runs ESLint only on staged `apps/` and `packages/` TypeScript or `.mjs` files.
- `pre-push` runs `npm run release:verify`, which matches the local single-machine equivalent of CI as closely as practical.

This split keeps commits fast while still blocking pushes that would obviously fail on CI.

If you need to bypass the push hook intentionally, set `SKIP_PRE_PUSH=1` for that push only.

Call out release impact in the PR when the change affects the published `rmtcdx` package in a way users may care about:

- CLI behavior
- bridge or bundled web UI behavior
- install, startup, upgrade, rollback, or compatibility expectations

You usually do not need a user-facing release note for:

- docs-only changes
- test-only changes
- CI-only or repo-only changes that do not alter the published package

For user-facing PRs, add a short release note draft to the PR summary:

- what changed for users
- any upgrade or rollback caveat
- whether the change is additive, behavioral, or breaking

## Merge and Release

- Prefer squash merge so the main branch stays easy to scan.
- Merging a normal PR to `main` does not publish immediately.
- Version bumps, changelog text, and npm publish are manual until a replacement release flow lands.
- Before publish, review merged PRs since the last release and turn their release-impact notes into the final release note.

Relevant automation:

- `CI` runs typecheck, lint, tests, and a packaged CLI smoke test.
- Local git hooks keep the common lint and pre-push checks in place.

## Hotfix Flow

- Branch from `main` with `hotfix/<topic>`.
- Merge the PR after review and green checks.
- Bump the package version manually and publish when the fix is ready.

## User Upgrade and Rollback

Always stop the current background process first. `rmtcdx up` reuses an existing running process when it finds one.

Upgrade to the current release:

```bash
npx rmtcdx stop
npx rmtcdx@latest up
```

Roll back to an exact known-good version:

```bash
npx rmtcdx stop
npx rmtcdx@0.1.0 up
```

For maintainers, if a release is bad, move `latest` back to the last-known-good version and deprecate the bad one instead of unpublishing it.

## Local Release Verification

Run the same packaged smoke path used by CI:

```bash
npm run smoke:package
```

For a full pre-release check:

```bash
npm run release:verify
```

## GitHub Settings To Enable

Configure the repository so the documented workflow is enforced:

- protect `main`
- require a pull request before merge
- require `CI`
- restrict direct pushes to `main`
- allow squash merge

## Real Codex Canary

The repository already has a real Codex canary runner, but it is not wired into scheduled GitHub Actions yet. That part still needs Codex CLI installation and authentication material in CI, so release automation currently stops at packaged smoke coverage.
