import assert from "node:assert/strict";
import test from "node:test";
import type { Repository } from "@codex-remote/shared-types";
import {
  findLogicalRepoGroupByRepoId,
  groupByLogicalRepoLabel,
  logicalRepoIdSetForSelection,
  representativeRepoIdForSelection
} from "./logical-repo-groups";

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

test("groupByLogicalRepoLabel merges repos that share the same label while preserving first-match order", () => {
  const repos = [
    createRepo({ id: "repo-a-main", name: "Repo A" }),
    createRepo({ id: "repo-b", name: "Repo B" }),
    createRepo({ id: "repo-a-worktree", name: "Repo A" })
  ];

  const groups = groupByLogicalRepoLabel(repos, (repo) => repo.name);

  assert.deepEqual(
    groups.map((group) => ({
      key: group.repoKey,
      repoIds: group.items.map((repo) => repo.id)
    })),
    [
      { key: "Repo A", repoIds: ["repo-a-main", "repo-a-worktree"] },
      { key: "Repo B", repoIds: ["repo-b"] }
    ]
  );
});

test("logicalRepoIdSetForSelection expands a selected repo to every repo in the same logical group", () => {
  const repos = [
    createRepo({ id: "repo-a-main", name: "Repo A" }),
    createRepo({ id: "repo-b", name: "Repo B" }),
    createRepo({ id: "repo-a-worktree", name: "Repo A" })
  ];
  const groups = groupByLogicalRepoLabel(repos, (repo) => repo.name);

  assert.deepEqual(
    [...(logicalRepoIdSetForSelection(groups, "repo-a-worktree") ?? [])],
    ["repo-a-main", "repo-a-worktree"]
  );
  assert.equal(findLogicalRepoGroupByRepoId(groups, "repo-b")?.repoKey, "Repo B");
});

test("representativeRepoIdForSelection returns the group's first repo id", () => {
  const repos = [
    createRepo({ id: "repo-a-main", name: "Repo A" }),
    createRepo({ id: "repo-a-worktree", name: "Repo A" })
  ];
  const groups = groupByLogicalRepoLabel(repos, (repo) => repo.name);

  assert.equal(representativeRepoIdForSelection(groups, "repo-a-worktree"), "repo-a-main");
});
