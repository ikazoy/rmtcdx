import type { Message, Repository, SessionDetail, SessionSummary } from "@codex-remote/shared-types";

export type PendingThread = {
  sessionId: string;
  repoId: string;
  repoName?: string;
  prompt: string;
  createdAt: string;
};

export type SidebarViewState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "ready"; sessions: SessionSummary[]; isRefreshing: boolean };

export type ChatViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      detail: SessionDetail;
      messages: Message[];
      repoName?: string;
      isLoadingMessages: boolean;
      hasResolvedDetail: boolean;
    };

export function buildPendingSessionSummary(thread: PendingThread): SessionSummary {
  const prompt = thread.prompt.trim();
  const title = prompt ? prompt.slice(0, 80) : "New session";
  const summary = prompt || (thread.repoName ? `Starting a conversation in ${thread.repoName}` : "Starting a conversation");

  return {
    id: thread.sessionId,
    repoId: thread.repoId,
    repoName: thread.repoName,
    title,
    summary,
    status: "running",
    isArchived: false,
    unreadCount: 0,
    lastEventSeq: 0,
    lastReadEventSeq: 0,
    lastMessageAt: thread.createdAt,
    lastUserMessageAt: thread.createdAt,
    latestTurnStatus: "inProgress",
    threadStatusType: "active",
    latestUserPrompt: prompt || undefined,
    hasUnreadCompletion: false,
    hasUnreadError: false,
    createdAt: thread.createdAt,
    updatedAt: thread.createdAt
  };
}

export function buildPendingSessionDetail(summary: SessionSummary): SessionDetail {
  return {
    session: summary,
    activeRun: null,
    latestRun: null
  };
}

export function buildDraftSessionDetail(sessionId: string, repo: Repository, createdAt: string): SessionDetail {
  return {
    session: {
      id: sessionId,
      repoId: repo.id,
      repoName: repo.name,
      title: "New session",
      summary: `Start a conversation in ${repo.name}`,
      status: "idle",
      isArchived: false,
      unreadCount: 0,
      lastEventSeq: 0,
      lastReadEventSeq: 0,
      lastMessageAt: createdAt,
      hasUnreadCompletion: false,
      hasUnreadError: false,
      createdAt,
      updatedAt: createdAt
    },
    activeRun: null,
    latestRun: null
  };
}

export function buildVisibleSessions(
  sessions: SessionSummary[],
  selectedRepoId: string | null,
  pendingThread: PendingThread | null
) {
  const pendingSessionSummary =
    pendingThread &&
    (!selectedRepoId || selectedRepoId === pendingThread.repoId) &&
    !sessions.some((session) => session.id === pendingThread.sessionId)
      ? buildPendingSessionSummary(pendingThread)
      : null;

  return pendingSessionSummary ? [pendingSessionSummary, ...sessions] : sessions;
}

export function buildSidebarViewState({
  sessions,
  isPending,
  isFetching,
  error
}: {
  sessions: SessionSummary[];
  isPending: boolean;
  isFetching: boolean;
  error: Error | null;
}): SidebarViewState {
  if (sessions.length === 0 && (isPending || isFetching)) {
    return { kind: "loading" };
  }

  if (sessions.length === 0 && error) {
    return { kind: "error", message: error.message || "Unable to load threads." };
  }

  if (sessions.length === 0) {
    return { kind: "empty" };
  }

  return {
    kind: "ready",
    sessions,
    isRefreshing: isFetching
  };
}

export function buildChatViewState({
  sessionId,
  draftDetail,
  selectedSessionSummary,
  detail,
  detailIsPending,
  detailError,
  messages,
  messagesIsFetching,
  repoName
}: {
  sessionId: string | null;
  draftDetail: SessionDetail | null;
  selectedSessionSummary: SessionSummary | null;
  detail: SessionDetail | undefined;
  detailIsPending: boolean;
  detailError: Error | null;
  messages: Message[];
  messagesIsFetching: boolean;
  repoName?: string;
}): ChatViewState {
  if (!sessionId) {
    return { kind: "idle" };
  }

  if (draftDetail) {
    return {
      kind: "ready",
      detail: draftDetail,
      messages: [],
      repoName: repoName ?? draftDetail.session.repoName,
      isLoadingMessages: false,
      hasResolvedDetail: true
    };
  }

  const resolvedDetail = detail ?? (selectedSessionSummary ? buildPendingSessionDetail(selectedSessionSummary) : null);
  if (resolvedDetail) {
    return {
      kind: "ready",
      detail: resolvedDetail,
      messages,
      repoName: repoName ?? resolvedDetail.session.repoName,
      isLoadingMessages: messagesIsFetching,
      hasResolvedDetail: Boolean(detail)
    };
  }

  if (detailError) {
    return { kind: "error", message: detailError.message || "Unable to load this thread." };
  }

  if (detailIsPending) {
    return { kind: "loading" };
  }

  return { kind: "loading" };
}
