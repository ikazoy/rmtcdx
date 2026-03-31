import assert from "node:assert/strict";
import test from "node:test";
import type { Repository } from "@codex-remote/shared-types";
import { pickDraftRepoFallback, resolveDraftRepoId } from "./repo-defaults";

function createRepo(overrides: Partial<Repository> & Pick<Repository, "id" | "name">): Repository {
  const { id, name, ...rest } = overrides;

  return {
    path: `/tmp/${id}`,
    description: undefined,
    branch: "main",
    pinned: false,
    runningSessionCount: 0,
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z",
    ...rest,
    id,
    name
  };
}

test("resolveDraftRepoId prefers an explicit sidebar repo over the currently open session repo", () => {
  const repos = [
    createRepo({ id: "repo-a", name: "Repo A" }),
    createRepo({ id: "repo-b", name: "Repo B", pinned: true })
  ];

  const resolved = resolveDraftRepoId({
    repos,
    currentSessionRepoId: "repo-a",
    lastDraftRepoId: "repo-b",
    selectedRepoId: "repo-b",
    selectedRepoSource: "user"
  });

  assert.equal(resolved, "repo-b");
});

test("resolveDraftRepoId falls back to the current session repo when no explicit sidebar repo is set", () => {
  const repos = [
    createRepo({ id: "repo-a", name: "Repo A" }),
    createRepo({ id: "repo-b", name: "Repo B" })
  ];

  const resolved = resolveDraftRepoId({
    repos,
    currentSessionRepoId: "repo-a",
    lastDraftRepoId: "repo-b",
    selectedRepoId: null,
    selectedRepoSource: "system"
  });

  assert.equal(resolved, "repo-a");
});

test("resolveDraftRepoId ignores a restored sidebar repo and falls back to the last draft repo", () => {
  const repos = [
    createRepo({ id: "repo-a", name: "Repo A" }),
    createRepo({ id: "repo-b", name: "Repo B" })
  ];

  const resolved = resolveDraftRepoId({
    repos,
    currentSessionRepoId: null,
    lastDraftRepoId: "repo-a",
    selectedRepoId: "repo-b",
    selectedRepoSource: "restored"
  });

  assert.equal(resolved, "repo-a");
});

test("pickDraftRepoFallback prefers running repos, then pinned repos, then recency", () => {
  const repos = [
    createRepo({
      id: "repo-old",
      name: "Old Repo",
      updatedAt: "2026-03-20T00:00:00.000Z"
    }),
    createRepo({
      id: "repo-pinned",
      name: "Pinned Repo",
      pinned: true,
      updatedAt: "2026-03-21T00:00:00.000Z"
    }),
    createRepo({
      id: "repo-running",
      name: "Running Repo",
      runningSessionCount: 2,
      updatedAt: "2026-03-19T00:00:00.000Z"
    })
  ];

  assert.equal(pickDraftRepoFallback(repos)?.id, "repo-running");
});

test("resolveDraftRepoId returns null when no repos are available", () => {
  const resolved = resolveDraftRepoId({
    repos: [],
    currentSessionRepoId: null,
    lastDraftRepoId: null,
    selectedRepoId: null,
    selectedRepoSource: "system"
  });

  assert.equal(resolved, null);
});
