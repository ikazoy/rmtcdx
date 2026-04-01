# CLI Update Command Design

This document proposes an explicit update flow for the end-user CLI described in [docs/cli.md](./cli.md).

## Background

Today `rmtcdx` exposes a small CLI:

- `rmtcdx up`
- `rmtcdx up --tailscale`
- `rmtcdx stop`
- `rmtcdx status`

That shape is intentionally small, but it leaves upgrade and rollback to raw `npx rmtcdx@latest up` or `npx rmtcdx@<version> up` commands.

There is also an implementation constraint:

- `rmtcdx up` reuses an already-running background bridge instead of replacing it
- the CLI is usually launched through `npx` / `npm exec`, which resolves a package for one invocation rather than patching an installed binary in place

Because of that, "auto-update inside the running bin script" should be modeled as an explicit handoff to another package version, not as an in-place self-rewrite.

## Goals

- Give users a one-command way to move to the current stable release.
- Keep rollback to an exact version simple and predictable.
- Preserve the current runtime shape, including Tailscale mode, unless the user asks otherwise.
- Keep `up` deterministic and offline-friendly by default.
- Match npm package and dist-tag semantics instead of hiding them.

## Non-goals

- Silent update checks on every `up`.
- In-place mutation of the currently running CLI package.
- Background auto-update while the bridge keeps serving traffic.
- General package-manager abstraction beyond the npm registry flow needed for `npx`.

## Proposed Commands

### `rmtcdx check-update`

Read-only command that compares the current CLI version with the package registry.

Output should include:

- current CLI version
- current `latest` version
- whether an update is available
- the exact command to upgrade
- the exact command to roll back to the current version

Examples:

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

Explicitly switches the running bridge to another published package version.

Default target:

- `latest`

Examples:

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

Selects the package target to hand off to.

Accepted values:

- exact version such as `0.1.0`
- dist-tag such as `latest` or `next`

This should map to `rmtcdx@<tag-or-version>`.

### `--tailscale`

Forces the relaunched version to start with Tailscale enabled.

### `--no-tailscale`

Forces the relaunched version to start without Tailscale enabled.

Without either flag, `update` should preserve the current runtime's Tailscale mode when a bridge is already running.

## Command Semantics

### `check-update`

`check-update` should:

1. read the current CLI package version from its own `package.json`
2. query the npm registry for `rmtcdx@latest`
3. print a human-readable result
4. exit `0` on success and `1` on lookup failure

It should not modify runtime state or stop the bridge.

### `update`

`update` should:

1. read the current CLI package version
2. resolve the target version from `--to` or `latest`
3. read runtime state if present
4. decide the next Tailscale mode:
   - explicit flag wins
   - otherwise preserve the running mode
   - otherwise default to disabled
5. if the running version is already the target version and the desired Tailscale mode matches, print a no-op message and exit `0`
6. stop the current bridge if it is running
7. hand off to the target version with `npx`
8. exit with the handed-off command's exit code

## Handoff Strategy

The command should not try to overwrite the current package files.

Instead, it should launch the requested version explicitly:

```bash
npx --yes --prefer-online rmtcdx@<target> up
```

When Tailscale should be enabled:

```bash
npx --yes --prefer-online rmtcdx@<target> up --tailscale
```

Reasons:

- `npx` already resolves package specs, tags, and cache behavior
- `--prefer-online` reduces stale-cache surprises when users ask for `latest`
- exact versions still work naturally for rollback

## Runtime State Changes

To make `status` and `update` accurate, runtime state should persist the version that started the background bridge.

Add a field to runtime state:

```ts
version: string
```

This should be written by `up` and reported by `status`.

## Status Output Changes

`rmtcdx status` should add:

- `Version: <version>`

This avoids ambiguity when the user runs one CLI version but an older bridge instance is still running in the background.

## Failure Behavior

### Registry lookup failure

- `check-update` should fail with a clear network or registry error
- `update` should fail before stopping anything if it cannot resolve the target version

### Handoff failure after stop

If the current bridge has already been stopped and the handoff command fails, `update` should:

- print the failed target
- print a recovery command for the current version
- exit non-zero

Example:

```text
Update failed while starting 0.1.2.
Recovery: npx rmtcdx@0.1.0 up
```

`update` should not attempt an implicit rollback on its own. Automatic rollback would make failure handling less predictable, especially when the original failure was caused by environment drift instead of the package version itself.

## User-Facing Guidance

The public guidance should remain explicit:

- normal upgrade: `npx rmtcdx update`
- manual stable path: `npx rmtcdx@latest up`
- exact rollback: `npx rmtcdx update --to 0.1.0`
- manual exact rollback: `npx rmtcdx stop && npx rmtcdx@0.1.0 up`

That keeps docs aligned with npm package specs and dist-tags rather than inventing a separate release channel model.

## Maintainer Interaction

This design assumes:

- stable releases move the `latest` dist-tag
- broken releases are handled by moving `latest` back to the previous good version
- bad versions can be deprecated in npm

That makes `rmtcdx update` follow the current stable stream automatically, while `--to <version>` remains the escape hatch.

## Future Work

- `--json` output for `check-update`
- `status` showing "update available" when explicitly asked
- launcher detection for `bunx` handoff
- prerelease channel guidance beyond `latest` and exact versions
