import type { Repository } from "@codex-remote/shared-types";
import type { RepoSelectionSource } from "../../store/ui-store";

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

export function pickDraftRepoFallback(repos: Repository[]) {
  if (repos.length === 0) {
    return null;
  }

  return [...repos]
    .sort((left, right) => {
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
    })[0] ?? null;
}

export function resolveDraftRepoId({
  repos,
  currentSessionRepoId,
  lastDraftRepoId,
  selectedRepoId,
  selectedRepoSource
}: ResolveDraftRepoIdOptions) {
  if (hasRepo(repos, currentSessionRepoId)) {
    return currentSessionRepoId;
  }

  if (selectedRepoSource === "user" && hasRepo(repos, selectedRepoId)) {
    return selectedRepoId;
  }

  if (hasRepo(repos, lastDraftRepoId)) {
    return lastDraftRepoId;
  }

  return pickDraftRepoFallback(repos)?.id ?? null;
}
