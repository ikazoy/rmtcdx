import type { Repository, SessionSummary } from "@codex-remote/shared-types";

const UNKNOWN_WORKSPACE_LABEL = "Unknown workspace";
const UNKNOWN_BRANCH_LABEL = "no branch";

function lastPathSegment(pathname: string) {
  return pathname.split("/").filter(Boolean).at(-1) ?? pathname;
}

function repoLabelSuffix(repo: Pick<Repository, "name" | "branch" | "path">) {
  const branch = repo.branch?.trim();
  if (branch) {
    return branch;
  }

  const pathSegment = lastPathSegment(repo.path);
  if (pathSegment && pathSegment !== repo.name) {
    return pathSegment;
  }

  return UNKNOWN_BRANCH_LABEL;
}

export function formatRepoName(repo: Pick<Repository, "name">) {
  return repo.name;
}

export function sortReposForDisplay(repos: Repository[]) {
  return [...repos].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

export function formatRepoLabel(repo: Pick<Repository, "name" | "branch" | "path">) {
  return `${repo.name} · ${repoLabelSuffix(repo)}`;
}

export function formatRepoVariantLabel(repo: Pick<Repository, "name" | "branch" | "path">) {
  return repoLabelSuffix(repo);
}

export function buildRepoLabelFormatter(repos: Repository[]) {
  const labelsById = new Map(
    repos.map((repo) => [repo.id, formatRepoLabel(repo)] satisfies readonly [string, string])
  );

  return (repo: Repository) => {
    return labelsById.get(repo.id) ?? formatRepoLabel(repo);
  };
}

export function buildRepoNameFormatter(repos: Repository[]) {
  const namesById = new Map(
    repos.map((repo) => [repo.id, formatRepoName(repo)] satisfies readonly [string, string])
  );

  return (repo: Repository) => {
    return namesById.get(repo.id) ?? formatRepoName(repo);
  };
}

export function buildRepoVariantLabelFormatter(repos: Repository[]) {
  const labelsById = new Map(
    repos.map((repo) => [repo.id, formatRepoVariantLabel(repo)] satisfies readonly [string, string])
  );

  return (repo: Repository) => {
    return labelsById.get(repo.id) ?? formatRepoVariantLabel(repo);
  };
}

export function buildSessionRepoNameFormatter(repos: Repository[]) {
  const formatRepoName = buildRepoNameFormatter(repos);
  const namesById = new Map(
    repos.map((repo) => [repo.id, formatRepoName(repo)] satisfies readonly [string, string])
  );

  return (session: Pick<SessionSummary, "repoId" | "repoName">) => {
    return namesById.get(session.repoId) ?? session.repoName ?? UNKNOWN_WORKSPACE_LABEL;
  };
}

export function buildSessionRepoVariantLabelFormatter(repos: Repository[]) {
  const formatVariant = buildRepoVariantLabelFormatter(repos);
  const labelsById = new Map(
    repos.map((repo) => [repo.id, formatVariant(repo)] satisfies readonly [string, string])
  );

  return (session: Pick<SessionSummary, "repoId">) => {
    return labelsById.get(session.repoId) ?? null;
  };
}
