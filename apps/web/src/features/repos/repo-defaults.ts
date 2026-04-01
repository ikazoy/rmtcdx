import type { Repository } from "@codex-remote/shared-types";
import type { RepoSelectionSource } from "../../store/ui-store";
import { buildRepoNameFormatter } from "./repo-presentation";
import { groupByLogicalRepoLabel, representativeRepoIdForSelection } from "./logical-repo-groups";

type ResolveDraftRepoIdOptions = {
  repos: Repository[];
  currentSessionRepoId: string | null;
  lastDraftRepoId: string | null;
  selectedRepoId: string | null;
  selectedRepoSource: RepoSelectionSource;
};

function hasRepo(repos: Repository[], repoId: string | null) {
  return Boolean(repoId && repos.some((repo) => repo.id === repoId));
}

function compareIsoDesc(leftIso: string, rightIso: string) {
  return new Date(rightIso).getTime() - new Date(leftIso).getTime();
}

function sortDraftRepoCandidates(repos: Repository[]) {
  return [...repos].sort((left, right) => {
    if (left.runningSessionCount !== right.runningSessionCount) {
      return right.runningSessionCount - left.runningSessionCount;
    }
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }
    const updatedAtDiff = compareIsoDesc(left.updatedAt, right.updatedAt);
    if (updatedAtDiff !== 0) {
      return updatedAtDiff;
    }
    const createdAtDiff = compareIsoDesc(left.createdAt, right.createdAt);
    if (createdAtDiff !== 0) {
      return createdAtDiff;
    }
    return left.name.localeCompare(right.name);
  });
}

export function pickDraftRepoFallback(repos: Repository[]) {
  if (repos.length === 0) {
    return null;
  }

  const orderedRepos = sortDraftRepoCandidates(repos);
  const formatRepoName = buildRepoNameFormatter(orderedRepos);
  const repoGroups = groupByLogicalRepoLabel(orderedRepos, formatRepoName);
  return repoGroups[0]?.items[0] ?? null;
}

export function resolveDraftRepoId({
  repos,
  currentSessionRepoId,
  lastDraftRepoId,
  selectedRepoId,
  selectedRepoSource
}: ResolveDraftRepoIdOptions) {
  const orderedRepos = sortDraftRepoCandidates(repos);
  const formatRepoName = buildRepoNameFormatter(orderedRepos);
  const repoGroups = groupByLogicalRepoLabel(orderedRepos, formatRepoName);
  const resolveRepoId = (repoId: string | null) => representativeRepoIdForSelection(repoGroups, repoId);

  if (selectedRepoSource === "user" && hasRepo(repos, selectedRepoId)) {
    return resolveRepoId(selectedRepoId);
  }

  if (hasRepo(repos, currentSessionRepoId)) {
    return resolveRepoId(currentSessionRepoId);
  }

  if (hasRepo(repos, lastDraftRepoId)) {
    return resolveRepoId(lastDraftRepoId);
  }

  return pickDraftRepoFallback(repos)?.id ?? null;
}
