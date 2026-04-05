import type { SessionFilter, SessionSummary } from "@codex-remote/shared-types";

export const DEFAULT_REPO_GROUP_VISIBLE_SESSION_LIMIT = 10;
export const EXPANDED_REPO_GROUP_VISIBLE_SESSION_LIMIT = 30;
export type RepoGroupIndicator = "error" | "pending" | "unread" | "running";

function effectivePendingRequestCount(
  session: Pick<SessionSummary, "id" | "pendingRequestCount">,
  {
    selectedSessionId,
    selectedSessionPendingRequestCount
  }: {
    selectedSessionId?: string | null;
    selectedSessionPendingRequestCount?: number;
  }
) {
  if (session.id !== selectedSessionId) {
    return session.pendingRequestCount;
  }

  return Math.max(session.pendingRequestCount, selectedSessionPendingRequestCount ?? 0);
}

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
    collapsedLimit = DEFAULT_REPO_GROUP_VISIBLE_SESSION_LIMIT,
    expandedLimit = EXPANDED_REPO_GROUP_VISIBLE_SESSION_LIMIT
  }: {
    isExpanded: boolean;
    collapsedLimit?: number;
    expandedLimit?: number;
  }
) {
  const limit = isExpanded ? expandedLimit : collapsedLimit;
  return sessions.slice(0, limit);
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
  visibleCount,
  collapsedLimit = DEFAULT_REPO_GROUP_VISIBLE_SESSION_LIMIT,
  expandedLimit = EXPANDED_REPO_GROUP_VISIBLE_SESSION_LIMIT
}: {
  totalCount: number;
  visibleCount: number;
  collapsedLimit?: number;
  expandedLimit?: number;
}) {
  if (visibleCount > collapsedLimit) {
    return "Show less";
  }

  const expandedCount = Math.min(totalCount, expandedLimit);
  const additionalCount = Math.max(expandedCount - visibleCount, 0);
  return additionalCount > 0 ? `Show ${additionalCount} more` : "Show less";
}

export function getRepoGroupIndicators(
  sessions: SessionSummary[],
  {
    selectedSessionId = null,
    selectedSessionPendingRequestCount = 0
  }: {
    selectedSessionId?: string | null;
    selectedSessionPendingRequestCount?: number;
  } = {}
): RepoGroupIndicator[] {
  const activeSessions = sessions.filter((session) => !session.isArchived);
  const hasError = activeSessions.some((session) => session.hasUnreadError || session.status === "error");
  const hasPending = activeSessions.some(
    (session) =>
      effectivePendingRequestCount(session, {
        selectedSessionId,
        selectedSessionPendingRequestCount
      }) > 0
  );
  const hasUnread = activeSessions.some((session) => session.hasUnreadCompletion);

  if (hasError || hasPending || hasUnread) {
    return [
      ...(hasError ? (["error"] as const) : []),
      ...(hasPending ? (["pending"] as const) : []),
      ...(hasUnread ? (["unread"] as const) : [])
    ];
  }

  return activeSessions.some((session) => session.status === "running") ? ["running"] : [];
}

export function repoGroupIndicatorsLabel(indicators: RepoGroupIndicator[]) {
  if (indicators.length === 0) {
    return null;
  }

  const parts = indicators.map((indicator) => {
    switch (indicator) {
      case "error":
        return "errors";
      case "pending":
        return "pending requests";
      case "unread":
        return "unread threads";
      case "running":
        return "running threads";
    }
  });

  return indicators[0] === "running" ? "Has running threads" : `Needs attention: ${parts.join(", ")}`;
}
