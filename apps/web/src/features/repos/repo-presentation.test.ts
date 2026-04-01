import assert from "node:assert/strict";
import test from "node:test";
import type { Repository } from "@codex-remote/shared-types";
import { sortReposForDisplay } from "./repo-presentation";

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

test("sortReposForDisplay orders repos by latest activity first", () => {
  const repos = [
    createRepo({
      id: "repo-stale",
      name: "Stale Repo",
      pinned: true,
      updatedAt: "2026-03-20T00:00:00.000Z"
    }),
    createRepo({
      id: "repo-recent",
      name: "Recent Repo",
      updatedAt: "2026-03-31T12:00:00.000Z"
    }),
    createRepo({
      id: "repo-middle",
      name: "Middle Repo",
      updatedAt: "2026-03-25T08:00:00.000Z"
    })
  ];

  assert.deepEqual(
    sortReposForDisplay(repos).map((repo) => repo.id),
    ["repo-recent", "repo-middle", "repo-stale"]
  );
});

test("sortReposForDisplay keeps pinned repos ahead only when recency is tied", () => {
  const repos = [
    createRepo({
      id: "repo-unpinned",
      name: "Alpha Repo",
      updatedAt: "2026-03-31T12:00:00.000Z",
      createdAt: "2026-03-28T00:00:00.000Z"
    }),
    createRepo({
      id: "repo-pinned",
      name: "Zulu Repo",
      pinned: true,
      updatedAt: "2026-03-31T12:00:00.000Z",
      createdAt: "2026-03-28T00:00:00.000Z"
    })
  ];

  assert.deepEqual(
    sortReposForDisplay(repos).map((repo) => repo.id),
    ["repo-pinned", "repo-unpinned"]
  );
});
