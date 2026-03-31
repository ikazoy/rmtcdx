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
- Wait for `CI` and `Changeset Required` to pass before merging.
- Use the PR template and state whether a changeset is included.

## Local Gates

`npm install` configures local git hooks through `.githooks`.

- `pre-commit` runs ESLint only on staged `apps/` and `packages/` TypeScript or `.mjs` files.
- `pre-push` runs `npm run release:verify`, which matches the local single-machine equivalent of CI as closely as practical.

This split keeps commits fast while still blocking pushes that would obviously fail on CI.

If you need to bypass the push hook intentionally, set `SKIP_PRE_PUSH=1` for that push only.

Add a changeset when the PR changes the published `rmtcdx` package in a way users may care about:

- CLI behavior
- bridge or bundled web UI behavior
- install, startup, upgrade, rollback, or compatibility expectations

A changeset is usually not needed for:

- docs-only changes
- test-only changes
- CI-only or repo-only changes that do not alter the published package

Create a changeset with:

```bash
npm run changeset
```

Choose `rmtcdx`, pick the right bump level, and write the summary for end users.

## Merge and Release

- Prefer squash merge so the main branch stays easy to scan.
- Merging a normal PR to `main` does not publish immediately.
- The `Release` workflow opens or updates a release PR from pending changesets.
- Merge that release PR when you want to publish the queued version.
- Merging the release PR publishes `rmtcdx` to npm `latest` with npm provenance.

Relevant automation:

- `CI` runs typecheck, lint, tests, and a packaged CLI smoke test.
- `Changeset Required` blocks release-relevant PRs that forgot a changeset.
- `Release` manages version bumps, changelog updates, and npm publish.

## Hotfix Flow

- Branch from `main` with `hotfix/<topic>`.
- Add a patch changeset.
- Merge the PR after review and green checks.
- Merge the generated release PR to publish the hotfix.

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
- require `CI` and `Changeset Required`
- restrict direct pushes to `main`
- allow squash merge

## Real Codex Canary

The repository already has a real Codex canary runner, but it is not wired into scheduled GitHub Actions yet. That part still needs Codex CLI installation and authentication material in CI, so release automation currently stops at packaged smoke coverage.
