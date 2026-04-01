import type { Repository } from "@codex-remote/shared-types";

const UNKNOWN_LOGICAL_REPO_LABEL = "Unknown workspace";

export type LogicalRepoGroup<T> = {
  repoKey: string;
  repoLabel: string;
  items: T[];
};

export function normalizeLogicalRepoLabel(label: string | null | undefined) {
  const normalized = label?.trim();
  return normalized ? normalized : UNKNOWN_LOGICAL_REPO_LABEL;
}

export function groupByLogicalRepoLabel<T>(
  items: T[],
  getRepoLabel: (item: T) => string | null | undefined
): LogicalRepoGroup<T>[] {
  const groups = new Map<string, LogicalRepoGroup<T>>();

  for (const item of items) {
    const repoLabel = normalizeLogicalRepoLabel(getRepoLabel(item));
    const group = groups.get(repoLabel);
    if (group) {
      group.items.push(item);
      continue;
    }

    groups.set(repoLabel, {
      repoKey: repoLabel,
      repoLabel,
      items: [item]
    });
  }

  return [...groups.values()];
}

export function findLogicalRepoGroupByRepoId(
  groups: LogicalRepoGroup<Repository>[],
  repoId: string | null
) {
  if (!repoId) {
    return null;
  }

  return groups.find((group) => group.items.some((repo) => repo.id === repoId)) ?? null;
}

export function logicalRepoIdSetForSelection(
  groups: LogicalRepoGroup<Repository>[],
  repoId: string | null
) {
  if (!repoId) {
    return null;
  }

  const group = findLogicalRepoGroupByRepoId(groups, repoId);
  return new Set((group?.items ?? []).map((repo) => repo.id).concat(group ? [] : [repoId]));
}

export function representativeRepoIdForSelection(
  groups: LogicalRepoGroup<Repository>[],
  repoId: string | null
) {
  if (!repoId) {
    return null;
  }

  return findLogicalRepoGroupByRepoId(groups, repoId)?.items[0]?.id ?? repoId;
}
