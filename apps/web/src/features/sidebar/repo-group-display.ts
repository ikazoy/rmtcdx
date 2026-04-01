import type { SessionFilter, SessionSummary } from "@codex-remote/shared-types";

export const DEFAULT_REPO_GROUP_VISIBLE_SESSION_LIMIT = 10;

export function shouldLimitRepoGroupSessions({
  selectedRepoId,
  search,
  filter
}: {
  selectedRepoId: string | null;
  search: string;
  filter: SessionFilter;
}) {
  return selectedRepoId === null && search.trim().length === 0 && filter === "all";
}

export function getVisibleRepoGroupSessions(
  sessions: SessionSummary[],
  {
    isExpanded,
    limit = DEFAULT_REPO_GROUP_VISIBLE_SESSION_LIMIT
  }: {
    isExpanded: boolean;
    limit?: number;
  }
) {
  return isExpanded ? sessions : sessions.slice(0, limit);
}

export function shouldAutoExpandRepoGroup(
  sessions: SessionSummary[],
  selectedSessionId: string | null,
  limit = DEFAULT_REPO_GROUP_VISIBLE_SESSION_LIMIT
) {
  if (!selectedSessionId) {
    return false;
  }

  return sessions.findIndex((session) => session.id === selectedSessionId) >= limit;
}

export function repoGroupToggleLabel({
  totalCount,
  visibleCount
}: {
  totalCount: number;
  visibleCount: number;
}) {
  const hiddenCount = Math.max(totalCount - visibleCount, 0);
  return hiddenCount > 0 ? `Show ${hiddenCount} more` : "Show less";
}
