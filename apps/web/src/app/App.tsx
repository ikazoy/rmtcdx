import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";

import type {
  CodexDevRequestScenario,
  CodexRunSettings,
  CodexPendingRequestResponse,
  ImageAttachmentInput,
  Message,
  MessageAttachment,
  Repository,
  SessionFilter,
  SessionSummary,
  SessionsResponse
} from "@codex-remote/shared-types";
import { SESSION_FILTERS } from "@codex-remote/shared-types";
import { api } from "../api/client";
import { queryKeys } from "./query";
import { startAppViewportHeightTracking } from "./app-viewport-height";
import { bindAppDisplayModeChange } from "./display-mode";
import {
  buildChatViewState,
  buildDraftSessionDetail,
  buildPendingSessionDetail,
  buildPendingSessionSummary,
  buildSidebarViewState,
  buildVisibleSessions,
  mergeSessionSummaryIntoDetail,
  sessionDetailSyncKey
} from "./view-state";
import type { PendingThread } from "./view-state";
import { ChatPane } from "../features/chat/ChatPane";
import { DEFAULT_RUN_SETTINGS, pickRunSettings, runSettingsForRequest } from "../features/chat/run-settings";
import { CodexRequestDialog } from "../features/codex-requests/CodexRequestDialog";
import { resolveDraftRepoId } from "../features/repos/repo-defaults";
import { groupByLogicalRepoLabel, logicalRepoIdSetForSelection } from "../features/repos/logical-repo-groups";
import { buildRepoLabelFormatter, buildRepoNameFormatter, sortReposForDisplay } from "../features/repos/repo-presentation";
import { SidebarPane } from "../features/sidebar/SidebarPane";
import { useRealtime } from "../hooks/use-realtime";
import { hasActivitiesForSessionIds, hasStreamingTextForSessionIds, useUiStore } from "../store/ui-store";

const SIDEBAR_WIDTH_KEY = "codex-remote-sidebar-width";
const LAST_DRAFT_REPO_ID_KEY = "codex-remote-last-draft-repo-id";
const THREAD_LIST_FILTERS_KEY = "codex-remote-thread-list-filters";
const MOBILE_BREAKPOINT_PX = 860;
const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`;
const SIDEBAR_MIN_WIDTH_PX = 280;
const SIDEBAR_DEFAULT_WIDTH_PX = 320;
const SIDEBAR_MAX_WIDTH_PX = 640;
const SIDEBAR_CHAT_GUTTER_PX = 420;
const EMPTY_REPOS: Repository[] = [];
const EMPTY_SESSIONS: SessionSummary[] = [];
const EMPTY_MESSAGES: Message[] = [];

function readStoredThreadFilters() {
  if (typeof window === "undefined") {
    return { search: "", filter: "all" as SessionFilter };
  }

  try {
    const stored = window.localStorage.getItem(THREAD_LIST_FILTERS_KEY);
    if (!stored) {
      return { search: "", filter: "all" as SessionFilter };
    }

    const parsed = JSON.parse(stored) as {
      search?: unknown;
      filter?: unknown;
    };
    const search = typeof parsed.search === "string" ? parsed.search : "";
    const filter =
      typeof parsed.filter === "string" && SESSION_FILTERS.includes(parsed.filter as SessionFilter)
        ? (parsed.filter as SessionFilter)
        : "all";

    return { search, filter };
  } catch {
    return { search: "", filter: "all" as SessionFilter };
  }
}

function persistThreadFilters(search: string, filter: SessionFilter) {
  if (typeof window === "undefined") {
    return;
  }

  if (!search.trim() && filter === "all") {
    window.localStorage.removeItem(THREAD_LIST_FILTERS_KEY);
    return;
  }

  window.localStorage.setItem(
    THREAD_LIST_FILTERS_KEY,
    JSON.stringify({
      search,
      filter
    })
  );
}

function readStoredLastDraftRepoId() {
  if (typeof window === "undefined") {
    return null;
  }

  const stored = window.localStorage.getItem(LAST_DRAFT_REPO_ID_KEY)?.trim();
  return stored ? stored : null;
}

function persistLastDraftRepoId(repoId: string | null) {
  if (typeof window === "undefined") {
    return;
  }

  if (repoId) {
    window.localStorage.setItem(LAST_DRAFT_REPO_ID_KEY, repoId);
    return;
  }

  window.localStorage.removeItem(LAST_DRAFT_REPO_ID_KEY);
}

function createDraftSessionId() {
  return `draft:${Date.now()}`;
}

type OptimisticUserMessage = {
  sessionId: string;
  prompt: string;
  attachments: MessageAttachment[];
};

type SessionTransition = {
  draftId: string;
  realId: string;
};

type PendingInterruptRun = {
  sessionId: string;
  runId: string;
};

function revokeOptimisticAttachments(message: OptimisticUserMessage | null) {
  for (const attachment of message?.attachments ?? []) {
    if (attachment.url.startsWith("blob:")) {
      URL.revokeObjectURL(attachment.url);
    }
  }
}

function messageMatchesOptimistic(message: Message, optimistic: OptimisticUserMessage) {
  if (message.role !== "user" || message.text.trim() !== optimistic.prompt.trim()) {
    return false;
  }

  const actualNames = (message.attachments ?? []).map((attachment) => attachment.name.trim().toLowerCase()).sort();
  const optimisticNames = optimistic.attachments.map((attachment) => attachment.name.trim().toLowerCase()).sort();

  return (
    actualNames.length === optimisticNames.length &&
    actualNames.every((name, index) => name === optimisticNames[index])
  );
}

function createOptimisticAttachments(files: File[]) {
  return files.map(
    (file) =>
      ({
        kind: "image",
        name: file.name || "image",
        url: URL.createObjectURL(file)
      }) satisfies MessageAttachment
  );
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error(`Unable to read ${file.name || "image"}.`));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error(`Unable to read ${file.name || "image"}.`));
    };
    reader.readAsDataURL(file);
  });
}

function readSidebarMaxWidth() {
  if (typeof window === "undefined") {
    return SIDEBAR_MAX_WIDTH_PX;
  }

  return Math.max(
    SIDEBAR_MIN_WIDTH_PX,
    Math.min(SIDEBAR_MAX_WIDTH_PX, window.innerWidth - SIDEBAR_CHAT_GUTTER_PX)
  );
}

function clampSidebarWidth(width: number) {
  return Math.min(Math.max(width, SIDEBAR_MIN_WIDTH_PX), readSidebarMaxWidth());
}

function readIsMobileViewport() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

function readIsPageVisible() {
  if (typeof document === "undefined") {
    return true;
  }

  return document.visibilityState === "visible";
}

function readIsWindowFocused() {
  if (typeof window === "undefined") {
    return true;
  }

  return window.document.hasFocus();
}

function buildSessionPath(sessionId: string) {
  return `/sessions/${encodeURIComponent(sessionId)}`;
}

function readSessionIdFromPathname(pathname: string) {
  if (!pathname.startsWith("/sessions/")) {
    return null;
  }

  const encodedSessionId = pathname.slice("/sessions/".length).replace(/\/+$/, "");
  if (!encodedSessionId) {
    return null;
  }

  try {
    return decodeURIComponent(encodedSessionId);
  } catch {
    return null;
  }
}

function debugUiState(label: string, payload: Record<string, unknown>) {
  if (import.meta.env.DEV) {
    console.info(`[ui-debug] ${label}`, payload);
  }
}

function sessionIdsForSelection(selectedSessionId: string | null, transition: SessionTransition | null) {
  const sessionIds = new Set<string>();
  if (selectedSessionId) {
    sessionIds.add(selectedSessionId);
  }

  if (transition) {
    if (selectedSessionId === transition.draftId) {
      sessionIds.add(transition.realId);
    }
    if (selectedSessionId === transition.realId) {
      sessionIds.add(transition.draftId);
    }
  }

  return sessionIds;
}

export function App() {
  useRealtime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useState(() => readStoredThreadFilters().search);
  const [filter, setFilter] = useState<SessionFilter>(() => readStoredThreadFilters().filter);
  const [optimisticMessage, setOptimisticMessage] = useState<OptimisticUserMessage | null>(null);
  const [pendingThread, setPendingThread] = useState<PendingThread | null>(null);
  const [sessionTransition, setSessionTransition] = useState<SessionTransition | null>(null);
  const [pendingResponseSessionId, setPendingResponseSessionId] = useState<string | null>(null);
  const [pendingInterruptRun, setPendingInterruptRun] = useState<PendingInterruptRun | null>(null);
  const [draftRepoIdBySessionId, setDraftRepoIdBySessionId] = useState<Record<string, string>>({});
  const [lastDraftRepoId, setLastDraftRepoId] = useState(() => readStoredLastDraftRepoId());
  const optimisticMessageRef = useRef<OptimisticUserMessage | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === "undefined") {
      return SIDEBAR_DEFAULT_WIDTH_PX;
    }

    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(stored) ? clampSidebarWidth(stored) : clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH_PX);
  });
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(() => readIsMobileViewport());
  const [isPageVisible, setIsPageVisible] = useState(() => readIsPageVisible());
  const [isWindowFocused, setIsWindowFocused] = useState(() => readIsWindowFocused());
  const deferredSearch = useDeferredValue(search);
  const routeSessionId = useMemo(() => readSessionIdFromPathname(location.pathname), [location.pathname]);

  useEffect(() => {
    optimisticMessageRef.current = optimisticMessage;
  }, [optimisticMessage]);

  useEffect(() => () => revokeOptimisticAttachments(optimisticMessageRef.current), []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    return startAppViewportHeightTracking(window, document);
  }, []);

  const selectedRepoId = useUiStore((state) => state.selectedRepoId);
  const selectedRepoSource = useUiStore((state) => state.selectedRepoSource);
  const runSettingsOverridesBySession = useUiStore((state) => state.runSettingsOverridesBySession);
  const userDefaultRunSettings = useUiStore((state) => state.userDefaultRunSettings);
  const syncRunSettingsForSession = useUiStore((state) => state.syncRunSettingsForSession);
  const setRunSettingsForSession = useUiStore((state) => state.setRunSettingsForSession);
  const resetRunSettingsForSession = useUiStore((state) => state.resetRunSettingsForSession);
  const consumeRunSettingsForSession = useUiStore((state) => state.consumeRunSettingsForSession);
  const selectedSessionId = routeSessionId;
  const isDraftSession = Boolean(selectedSessionId?.startsWith("draft:"));
  const selectedSessionIds = useMemo(
    () => sessionIdsForSelection(selectedSessionId, sessionTransition),
    [selectedSessionId, sessionTransition]
  );
  const selectedSessionIdList = useMemo(() => [...selectedSessionIds], [selectedSessionIds]);
  const mobilePane = selectedSessionId ? "chat" : "sidebar";
  const sidebarVisible = useUiStore((state) => state.sidebarVisible);
  const toggleSidebarVisible = useUiStore((state) => state.toggleSidebarVisible);
  const wsState = useUiStore((state) => state.wsState);
  const backendBanner = useUiStore((state) => state.backendBanner);
  const setSelectedRepoId = useUiStore((state) => state.setSelectedRepoId);
  const hasStreamingText = useUiStore((state) => hasStreamingTextForSessionIds(state.streaming, selectedSessionIdList));
  const hasLiveActivities = useUiStore((state) => hasActivitiesForSessionIds(state.activities, selectedSessionIdList));

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: api.health,
    refetchInterval: 15000
  });

  const codexModelsQuery = useQuery({
    queryKey: queryKeys.codexModels,
    queryFn: api.codexModels,
    staleTime: 5 * 60 * 1000
  });

  const reposQuery = useQuery({
    queryKey: queryKeys.repos,
    queryFn: api.repos
  });
  const repos = useMemo(() => reposQuery.data?.repos ?? EMPTY_REPOS, [reposQuery.data?.repos]);
  const orderedRepos = useMemo(() => sortReposForDisplay(repos), [repos]);
  const formatRepoName = useMemo(() => buildRepoNameFormatter(orderedRepos), [orderedRepos]);
  const logicalRepoGroups = useMemo(
    () => groupByLogicalRepoLabel(orderedRepos, formatRepoName),
    [formatRepoName, orderedRepos]
  );
  const selectedLogicalRepoIds = useMemo(
    () => logicalRepoIdSetForSelection(logicalRepoGroups, selectedRepoId),
    [logicalRepoGroups, selectedRepoId]
  );
  const backendFilteredRepoId = useMemo(() => {
    if (!selectedLogicalRepoIds || selectedLogicalRepoIds.size !== 1) {
      return null;
    }

    return [...selectedLogicalRepoIds][0] ?? null;
  }, [selectedLogicalRepoIds]);

  const sessionsQuery = useQuery({
    queryKey: queryKeys.sessions(selectedRepoId, deferredSearch, filter),
    queryFn: () => api.sessions(backendFilteredRepoId, deferredSearch, filter),
    refetchInterval: 10000
  });
  const sessions = useMemo(() => sessionsQuery.data?.sessions ?? EMPTY_SESSIONS, [sessionsQuery.data?.sessions]);
  const visibleSessions = buildVisibleSessions(sessions, selectedLogicalRepoIds, pendingThread);

  const sessionDetailQuery = useQuery({
    queryKey: queryKeys.session(selectedSessionId),
    queryFn: () => api.session(selectedSessionId!),
    enabled: Boolean(selectedSessionId) && !isDraftSession
  });

  const messagesQuery = useQuery({
    queryKey: queryKeys.messages(selectedSessionId),
    queryFn: () => api.messages(selectedSessionId!),
    enabled: Boolean(selectedSessionId) && !isDraftSession
  });

  const pendingCodexRequestsQuery = useQuery({
    queryKey: queryKeys.pendingCodexRequests(selectedSessionId),
    queryFn: () => api.pendingCodexRequests(selectedSessionId!),
    enabled: Boolean(selectedSessionId) && !isDraftSession
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia(MOBILE_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsMobileViewport(event.matches);
    };

    setIsMobileViewport(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleResize = () => {
      setSidebarWidth((current) => clampSidebarWidth(current));
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    const handleVisibilityChange = () => {
      setIsPageVisible(document.visibilityState === "visible");
    };
    const handleFocus = () => {
      setIsWindowFocused(true);
    };
    const handleBlur = () => {
      setIsWindowFocused(false);
    };

    handleVisibilityChange();
    setIsWindowFocused(window.document.hasFocus());
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  useEffect(() => {
    const firstSession = visibleSessions[0];
    if (isMobileViewport || routeSessionId || !firstSession) {
      return;
    }

    navigate(buildSessionPath(firstSession.id), { replace: true });
  }, [isMobileViewport, navigate, routeSessionId, visibleSessions]);

  useEffect(() => {
    const sessions = sessionsQuery.data?.sessions ?? [];
    const hasUnread = sessions.some((session) => session.hasUnreadCompletion || session.hasUnreadError);
    document.title = hasUnread ? "(•) Rmtcdx" : "Rmtcdx";
  }, [sessionsQuery.data?.sessions]);

  useEffect(() => {
    const selected = sessionsQuery.data?.sessions.find((session) => session.id === selectedSessionId);
    const selectedHasUnread = Boolean(selected?.hasUnreadCompletion || selected?.hasUnreadError);
    if (
      !selectedSessionId
      || isDraftSession
      || !selectedHasUnread
      || (!sessionDetailQuery.data || sessionDetailQuery.data.session.id !== selectedSessionId)
      || !sessionDetailQuery.isSuccess
      || !messagesQuery.isSuccess
      || !isPageVisible
      || !isWindowFocused
      || (isMobileViewport && mobilePane !== "chat")
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void api.markRead(selectedSessionId).catch(() => undefined);
    }, 750);

    return () => window.clearTimeout(timeoutId);
  }, [
    isDraftSession,
    isMobileViewport,
    isPageVisible,
    isWindowFocused,
    messagesQuery.isSuccess,
    mobilePane,
    selectedSessionId,
    sessionDetailQuery.data,
    sessionDetailQuery.isSuccess,
    sessionsQuery.data?.sessions
  ]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    persistThreadFilters(search, filter);
  }, [filter, search]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    document.body.dataset.mobilePane = isMobileViewport ? mobilePane : "desktop";

    return () => {
      delete document.body.dataset.mobilePane;
    };
  }, [isMobileViewport, mobilePane]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const cleanup = bindAppDisplayModeChange((displayMode) => {
      document.body.dataset.displayMode = displayMode;
    });

    return () => {
      cleanup();
      delete document.body.dataset.displayMode;
    };
  }, []);

  useEffect(() => {
    if (!isMobileViewport || mobilePane !== "chat" || typeof window === "undefined") {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "auto" });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [isMobileViewport, mobilePane, selectedSessionId]);

  useEffect(() => {
    persistLastDraftRepoId(lastDraftRepoId);
  }, [lastDraftRepoId]);

  const runMutation = useMutation({
    mutationFn: ({
      prompt,
      attachments,
      codexSettings
    }: {
      prompt: string;
      attachments: ImageAttachmentInput[];
      clientSessionId: string;
      codexSettings: CodexRunSettings;
    }) =>
      api.startRun(
        isDraftSession
          ? { repoId: activeDraftRepoId!, prompt, attachments, codex: runSettingsForRequest(codexSettings) }
          : { sessionId: selectedSessionId!, prompt, attachments, codex: runSettingsForRequest(codexSettings) }
      ),
    onSuccess: (data, variables) => {
      setOptimisticMessage((current) =>
        current && current.sessionId === variables.clientSessionId
          ? { ...current, sessionId: data.run.sessionId }
          : current
      );
      setPendingThread((current) =>
        current && current.sessionId === variables.clientSessionId
          ? { ...current, sessionId: data.run.sessionId }
          : current
      );
      setPendingResponseSessionId((current) =>
        current === variables.clientSessionId ? data.run.sessionId : current
      );
      setPendingInterruptRun({
        sessionId: data.run.sessionId,
        runId: data.run.id
      });
      consumeRunSettingsForSession(variables.clientSessionId, data.run.sessionId, variables.codexSettings);
      if (variables.clientSessionId.startsWith("draft:") && variables.clientSessionId !== data.run.sessionId) {
        setDraftRepoIdBySessionId((current) => {
          const next = { ...current };
          delete next[variables.clientSessionId];
          return next;
        });
        setSessionTransition({
          draftId: variables.clientSessionId,
          realId: data.run.sessionId
        });
      }
      const nextPath = buildSessionPath(data.run.sessionId);
      if (location.pathname !== nextPath || isDraftSession) {
        navigate(nextPath, {
          replace: isDraftSession
        });
      }
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sessions"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.session(data.run.sessionId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.messages(data.run.sessionId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.accountRateLimits })
      ]);
    },
    onError: (_error, variables) => {
      setOptimisticMessage((current) => {
        revokeOptimisticAttachments(current);
        return null;
      });
      setPendingThread((current) => (current?.sessionId === variables.clientSessionId ? null : current));
      setPendingResponseSessionId((current) => (current === variables.clientSessionId ? null : current));
    }
  });

  const interruptMutation = useMutation({
    mutationFn: (runId: string) => api.interruptRun(runId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(selectedSessionId) });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    }
  });

  const renameMutation = useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) => api.renameSession(sessionId, { title }),
    onSuccess: async (detail) => {
      queryClient.setQueryData(queryKeys.session(detail.session.id), detail);
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    }
  });

  const archiveMutation = useMutation({
    mutationFn: (sessionId: string) => api.archiveSession(sessionId),
    onSuccess: async (_data, sessionId) => {
      queryClient.setQueriesData<SessionsResponse>({ queryKey: ["sessions"] }, (current) =>
        current
          ? {
              sessions: current.sessions.filter((session) => session.id !== sessionId)
            }
          : current
      );
      queryClient.removeQueries({ queryKey: queryKeys.session(sessionId) });
      queryClient.removeQueries({ queryKey: queryKeys.messages(sessionId) });

      if (routeSessionId === sessionId) {
        const nextSessions = queryClient.getQueryData<SessionsResponse>(
          queryKeys.sessions(selectedRepoId, deferredSearch, filter)
        );
        const nextSessionId =
          buildVisibleSessions(nextSessions?.sessions ?? EMPTY_SESSIONS, selectedLogicalRepoIds, null)[0]?.id ?? null;
        navigate(nextSessionId ? buildSessionPath(nextSessionId) : "/", { replace: true });
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sessions"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.repos })
      ]);
    }
  });

  const restoreMutation = useMutation({
    mutationFn: (sessionId: string) => api.restoreSession(sessionId),
    onSuccess: async (detail) => {
      queryClient.setQueryData(queryKeys.session(detail.session.id), detail);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sessions"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.repos })
      ]);
    }
  });

  const codexRequestMutation = useMutation({
    mutationFn: ({ requestId, payload }: { requestId: string; payload: CodexPendingRequestResponse }) =>
      api.respondToCodexRequest(requestId, payload),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.pendingCodexRequests(selectedSessionId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(selectedSessionId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.messages(selectedSessionId) });
      debugUiState("codex-request-responded", {
        requestId: variables.requestId,
        selectedSessionId
      });
    }
  });

  const simulateCodexRequestMutation = useMutation({
    mutationFn: ({
      sessionId,
      scenario
    }: {
      sessionId: string;
      scenario: CodexDevRequestScenario;
    }) => api.simulateCodexRequest(sessionId, { scenario }),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.pendingCodexRequests(variables.sessionId) });
      debugUiState("codex-request-simulated", {
        sessionId: variables.sessionId,
        scenario: variables.scenario
      });
    }
  });

  const formatRepoLabel = useMemo(() => buildRepoLabelFormatter(orderedRepos), [orderedRepos]);
  const selectedRepo = repos.find((repo) => repo.id === selectedRepoId) ?? null;
  const selectedPolledSessionSummary =
    sessions.find((session) => selectedSessionIds.has(session.id)) ?? null;
  const selectedPolledSessionSyncKey = useMemo(
    () => sessionDetailSyncKey(selectedPolledSessionSummary),
    [selectedPolledSessionSummary]
  );
  const selectedDetailSessionSyncKey = useMemo(
    () => sessionDetailSyncKey(sessionDetailQuery.data?.session),
    [sessionDetailQuery.data?.session]
  );
  const mergedSessionDetail = useMemo(
    () => mergeSessionSummaryIntoDetail(sessionDetailQuery.data, selectedPolledSessionSummary),
    [selectedPolledSessionSummary, sessionDetailQuery.data]
  );
  const currentSessionRepoId = selectedSessionId
    ? isDraftSession
      ? (draftRepoIdBySessionId[selectedSessionId] ?? null)
      : (mergedSessionDetail?.session.repoId ?? selectedPolledSessionSummary?.repoId ?? null)
    : null;
  const defaultDraftRepoId = resolveDraftRepoId({
    repos,
    currentSessionRepoId,
    lastDraftRepoId,
    selectedRepoId,
    selectedRepoSource
  });
  const activeDraftRepoId =
    isDraftSession && selectedSessionId
      ? (draftRepoIdBySessionId[selectedSessionId] ?? defaultDraftRepoId)
      : null;
  const activeDraftRepo = repos.find((repo) => repo.id === activeDraftRepoId) ?? null;

  useEffect(() => {
    if (!isDraftSession || !selectedSessionId || !defaultDraftRepoId || draftRepoIdBySessionId[selectedSessionId]) {
      return;
    }

    setDraftRepoIdBySessionId((current) => ({
      ...current,
      [selectedSessionId]: defaultDraftRepoId
    }));
  }, [defaultDraftRepoId, draftRepoIdBySessionId, isDraftSession, selectedSessionId]);

  const lastHandledListRefreshRef = useRef<string | null>(null);

  useEffect(() => {
    const refreshKey = `${selectedSessionId ?? "none"}:${sessionsQuery.dataUpdatedAt}`;
    if (lastHandledListRefreshRef.current === refreshKey) {
      return;
    }
    lastHandledListRefreshRef.current = refreshKey;

    if (
      !selectedSessionId
      || isDraftSession
      || !selectedPolledSessionSummary
      || !sessionDetailQuery.data?.session
      || sessionDetailQuery.fetchStatus === "fetching"
    ) {
      return;
    }

    if (selectedPolledSessionSummary.id !== sessionDetailQuery.data.session.id) {
      return;
    }

    if (selectedPolledSessionSyncKey === selectedDetailSessionSyncKey) {
      return;
    }

    void queryClient.invalidateQueries({ queryKey: queryKeys.session(selectedSessionId) });
  }, [
    isDraftSession,
    queryClient,
    selectedDetailSessionSyncKey,
    selectedPolledSessionSummary,
    selectedPolledSessionSyncKey,
    selectedSessionId,
    sessionDetailQuery.data?.session,
    sessionDetailQuery.fetchStatus,
    sessionsQuery.dataUpdatedAt
  ]);

  const selectedSessionSummary =
    visibleSessions.find((session) => selectedSessionIds.has(session.id)) ?? null;
  const selectedSidebarSessionId = selectedSessionSummary?.id ?? selectedSessionId;
  const draftCreatedAt = new Date().toISOString();
  const pendingSessionSummaryForSelection =
    pendingThread && selectedSessionIds.has(pendingThread.sessionId)
      ? buildPendingSessionSummary(pendingThread)
      : null;
  const draftDetail =
    isDraftSession && activeDraftRepo
      ? pendingSessionSummaryForSelection
        ? buildPendingSessionDetail(pendingSessionSummaryForSelection)
        : buildDraftSessionDetail(selectedSessionId!, activeDraftRepo, draftCreatedAt)
      : null;
  const messages = useMemo(
    () => (isDraftSession ? EMPTY_MESSAGES : (messagesQuery.data?.messages ?? EMPTY_MESSAGES)),
    [isDraftSession, messagesQuery.data?.messages]
  );
  const pendingCodexRequests = isDraftSession ? [] : pendingCodexRequestsQuery.data?.requests ?? [];
  const currentPendingCodexRequest = pendingCodexRequests[0] ?? null;
  const authoritativeRunSettings = isDraftSession ? null : mergedSessionDetail?.runSettings ?? null;
  const currentRunSettings = selectedSessionId
    ? pickRunSettings({
        isDraftSession,
        sessionOverride: runSettingsOverridesBySession[selectedSessionId],
        authoritativeRunSettings,
        userDefaultRunSettings
      })
    : DEFAULT_RUN_SETTINGS;
  const availableModels = codexModelsQuery.data?.models ?? [];
  const devSimulatorAvailable = healthQuery.data?.devTools.codexRequestSimulator === true;
  const activeSessionRepo =
    activeDraftRepo
    ?? repos.find((repo) => repo.id === (mergedSessionDetail?.session.repoId ?? selectedSessionSummary?.repoId))
    ?? selectedRepo;
  const activeRepoName =
    (activeSessionRepo ? formatRepoLabel(activeSessionRepo) : null)
    ?? mergedSessionDetail?.session.repoName
    ?? selectedSessionSummary?.repoName;
  const draftRepoPicker =
    isDraftSession && activeDraftRepoId
      ? {
          repos,
          selectedRepoId: activeDraftRepoId,
          onSelectRepo: selectDraftRepo
        }
      : null;
  const optimisticMessageForSession =
    optimisticMessage && selectedSessionIds.has(optimisticMessage.sessionId) ? optimisticMessage : null;
  const sidebarViewState = buildSidebarViewState({
    sessions: visibleSessions,
    isPending: sessionsQuery.isPending,
    isFetching: sessionsQuery.isFetching,
    error: sessionsQuery.error instanceof Error ? sessionsQuery.error : null
  });
  const chatViewState = buildChatViewState({
    sessionId: selectedSessionId,
    draftDetail,
    selectedSessionSummary,
    detail: mergedSessionDetail,
    detailIsPending: sessionDetailQuery.isPending,
    detailError: sessionDetailQuery.error instanceof Error ? sessionDetailQuery.error : null,
    messages,
    messagesError: messagesQuery.error instanceof Error ? messagesQuery.error : null,
    messagesIsFetching: messagesQuery.isFetching,
    repoName: activeRepoName
  });
  const readyChatView = chatViewState.kind === "ready" ? chatViewState : null;
  const actionableDetail = readyChatView?.detail ?? null;
  const hasResolvedSessionDetail = readyChatView?.hasResolvedDetail ?? false;

  useEffect(() => {
    if (!selectedSessionId || isDraftSession) {
      return;
    }

    syncRunSettingsForSession(selectedSessionId, mergedSessionDetail?.runSettings ?? null);
  }, [isDraftSession, mergedSessionDetail?.runSettings, selectedSessionId, syncRunSettingsForSession]);

  useEffect(() => {
    debugUiState("chat-view", {
      routeSessionId: selectedSessionId,
      chatKind: chatViewState.kind,
      sidebarKind: sidebarViewState.kind,
      pendingThreadId: pendingThread?.sessionId ?? null,
      sessionTransition,
      pendingResponseSessionId,
      optimisticSessionId: optimisticMessageForSession?.sessionId ?? null,
      messageCount: messages.length,
      hasStreamingText,
      hasLiveActivities,
      activeRunStatus: readyChatView?.detail.activeRun?.status ?? null,
      latestRunStatus: readyChatView?.detail.latestRun?.status ?? null
    });
  }, [
    chatViewState.kind,
    hasLiveActivities,
    hasStreamingText,
    messages.length,
    optimisticMessageForSession?.sessionId,
    pendingResponseSessionId,
    pendingThread?.sessionId,
    readyChatView?.detail.activeRun?.status,
    readyChatView?.detail.latestRun?.status,
    selectedSessionId,
    sessionTransition,
    sidebarViewState.kind
  ]);
  const interruptibleRunId =
    actionableDetail?.activeRun?.id ??
    (pendingInterruptRun && selectedSessionIds.has(pendingInterruptRun.sessionId) ? pendingInterruptRun.runId : null);

  useEffect(() => {
    if (!pendingThread) {
      return;
    }

    const hasResolvedPendingThread =
      sessions.some((session) => session.id === pendingThread.sessionId) ||
      mergedSessionDetail?.session.id === pendingThread.sessionId;
    if (hasResolvedPendingThread) {
      setPendingThread(null);
    }
  }, [mergedSessionDetail?.session.id, pendingThread, sessions]);

  useEffect(() => {
    if (!sessionTransition) {
      return;
    }

    const selectionStillOnTransition =
      selectedSessionId === sessionTransition.draftId || selectedSessionId === sessionTransition.realId;
    if (!selectionStillOnTransition) {
      setSessionTransition(null);
      return;
    }

    const hasResolvedRealSession =
      sessions.some((session) => session.id === sessionTransition.realId) ||
      mergedSessionDetail?.session.id === sessionTransition.realId;
    if (hasResolvedRealSession && selectedSessionId === sessionTransition.realId) {
      setSessionTransition(null);
    }
  }, [mergedSessionDetail?.session.id, selectedSessionId, sessionTransition, sessions]);

  useEffect(() => {
    if (!optimisticMessageForSession) {
      return;
    }

    const confirmed = messages.some((message) => messageMatchesOptimistic(message, optimisticMessageForSession));
    if (confirmed) {
      setOptimisticMessage((current) => {
        revokeOptimisticAttachments(current);
        return null;
      });
    }
  }, [messages, optimisticMessageForSession]);

  useEffect(() => {
    if (!pendingResponseSessionId || !selectedSessionIds.has(pendingResponseSessionId)) {
      return;
    }

    const activeRunStatus = readyChatView?.detail.activeRun?.status ?? null;
    const latestRunStatus = readyChatView?.detail.latestRun?.status ?? null;
    const hasAssistantMessage = messages.some((message) => message.role === "assistant");
    const hasStartedResponding =
      hasStreamingText ||
      hasLiveActivities ||
      activeRunStatus === "queued" ||
      activeRunStatus === "running" ||
      hasAssistantMessage;
    const runFinished =
      latestRunStatus === "completed" ||
      latestRunStatus === "error" ||
      latestRunStatus === "interrupted";

    if (hasStartedResponding || runFinished) {
      setPendingResponseSessionId(null);
    }
  }, [hasLiveActivities, hasStreamingText, messages, pendingResponseSessionId, readyChatView, selectedSessionIds]);

  useEffect(() => {
    if (!pendingInterruptRun || pendingInterruptRun.sessionId !== selectedSessionId) {
      return;
    }

    if (actionableDetail?.activeRun?.id === pendingInterruptRun.runId) {
      setPendingInterruptRun(null);
      return;
    }

    const latestRun = actionableDetail?.latestRun;
    if (
      latestRun?.id === pendingInterruptRun.runId &&
      latestRun.status !== "queued" &&
      latestRun.status !== "running"
    ) {
      setPendingInterruptRun(null);
    }
  }, [
    actionableDetail?.activeRun?.id,
    actionableDetail?.latestRun,
    pendingInterruptRun,
    selectedSessionId
  ]);

  function selectRepo(repoId: string | null) {
    setSelectedRepoId(repoId, "user");
    if (location.pathname !== "/") {
      navigate("/", { replace: true });
    }
  }

  function selectDraftRepo(repoId: string) {
    if (!selectedSessionId) {
      return;
    }

    setDraftRepoIdBySessionId((current) => ({
      ...current,
      [selectedSessionId]: repoId
    }));
    setLastDraftRepoId(repoId);
  }

  const selectSession = (sessionId: string) => {
    const nextPath = buildSessionPath(sessionId);
    if (location.pathname !== nextPath) {
      navigate(nextPath);
    }
  };

  useEffect(() => {
    if (!selectedRepoId || !reposQuery.isSuccess) {
      return;
    }

    if (!repos.some((repo) => repo.id === selectedRepoId)) {
      setSelectedRepoId(null, "system");
      navigate("/", { replace: true });
    }
  }, [navigate, repos, reposQuery.isSuccess, selectedRepoId, setSelectedRepoId]);

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.innerWidth < MOBILE_BREAKPOINT_PX) {
      return;
    }

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    setIsResizingSidebar(true);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    };

    const handlePointerUp = () => {
      setIsResizingSidebar(false);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  const workspaceStyle = {
    "--sidebar-width": `${sidebarWidth}px`
  } as CSSProperties;
  const sidebarMaxWidth = readSidebarMaxWidth();

  return (
    <div className={`app-shell ${isResizingSidebar ? "is-resizing" : ""}`}>
      {backendBanner ? <div className="banner">{backendBanner}</div> : null}
      <CodexRequestDialog
        request={currentPendingCodexRequest}
        isSubmitting={codexRequestMutation.isPending}
        submitError={codexRequestMutation.error instanceof Error ? codexRequestMutation.error.message : null}
        onRespond={(payload) =>
          currentPendingCodexRequest
            ? codexRequestMutation.mutateAsync({
                requestId: currentPendingCodexRequest.id,
                payload
              }).then(() => undefined)
            : Promise.resolve()
        }
      />

      <main
        className="workspace-shell"
        data-mobile-pane={isMobileViewport ? mobilePane : "desktop"}
        data-sidebar-collapsed={!sidebarVisible}
        style={workspaceStyle}
      >
        <aside className="workspace-shell__sidebar" data-mobile-visible={mobilePane !== "chat"}>
          <SidebarPane
            repos={repos}
            isMobileViewport={isMobileViewport}
            selectedRepoId={selectedRepoId}
            sessionsState={sidebarViewState}
            selectedSessionId={selectedSidebarSessionId}
            selectedSessionPendingRequestCount={pendingCodexRequests.length}
            search={search}
            filter={filter}
            wsState={wsState}
            backendMode={healthQuery.data?.codex.mode}
            onSearchChange={setSearch}
            onFilterChange={setFilter}
            onSelectRepo={selectRepo}
            onSelectSession={selectSession}
            onToggleSidebar={toggleSidebarVisible}
            onHoverSession={(sessionId: string) => {
              void queryClient.prefetchQuery({
                queryKey: queryKeys.session(sessionId),
                queryFn: () => api.session(sessionId),
                staleTime: 30_000
              });
              void queryClient.prefetchQuery({
                queryKey: queryKeys.messages(sessionId),
                queryFn: () => api.messages(sessionId),
                staleTime: 30_000
              });
            }}
            isCreatingSession={false}
            canCreateSession={Boolean(defaultDraftRepoId)}
            onCreateSession={() => {
              if (!defaultDraftRepoId) {
                return;
              }
              const draftSessionId = createDraftSessionId();
              setDraftRepoIdBySessionId((current) => ({
                ...current,
                [draftSessionId]: defaultDraftRepoId
              }));
              navigate(buildSessionPath(draftSessionId));
            }}
          />
        </aside>

        {sidebarVisible ? (
          <div
            className="workspace-shell__resizer"
            onPointerDown={startSidebarResize}
            role="separator"
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            aria-valuemin={SIDEBAR_MIN_WIDTH_PX}
            aria-valuemax={sidebarMaxWidth}
            aria-valuenow={sidebarWidth}
            tabIndex={-1}
          />
        ) : null}

        <section className="workspace-shell__chat" data-mobile-visible={mobilePane === "chat"}>
          <ChatPane
            viewState={chatViewState}
            sessionIds={selectedSessionIdList}
            isMobileViewport={isMobileViewport}
            optimisticMessage={optimisticMessageForSession}
            pendingCodexRequestCount={pendingCodexRequests.length}
            runSettings={currentRunSettings}
            availableModels={availableModels}
            isLoadingModels={codexModelsQuery.isPending}
            modelsError={codexModelsQuery.error instanceof Error ? codexModelsQuery.error.message : null}
            devSimulatorAvailable={devSimulatorAvailable && !isDraftSession && hasResolvedSessionDetail}
            hasPendingResponse={Boolean(pendingResponseSessionId && selectedSessionIds.has(pendingResponseSessionId))}
            canInterruptRun={Boolean(interruptibleRunId)}
            draftRepoPicker={draftRepoPicker}
            onBack={() => {
              navigate("/", { replace: true });

              if (typeof window !== "undefined") {
                window.requestAnimationFrame(() => {
                  window.scrollTo({ top: 0, behavior: "auto" });
                });
              }
            }}
            onSubmit={async ({ prompt, files }) => {
              if (!selectedSessionId) {
                return;
              }

              // Show optimistic message immediately — before any async work.
              setPendingResponseSessionId(selectedSessionId);
              debugUiState("submit", {
                selectedSessionId,
                isDraftSession,
                draftRepoId: activeDraftRepoId,
                selectedRepoId,
                promptLength: prompt.length,
                fileCount: files.length
              });
              const createdAt = new Date().toISOString();
              if (isDraftSession && activeDraftRepoId) {
                setLastDraftRepoId(activeDraftRepoId);
                setPendingThread({
                  sessionId: selectedSessionId,
                  repoId: activeDraftRepoId,
                  repoName: activeDraftRepo?.name,
                  prompt,
                  createdAt
                });
              }

              setOptimisticMessage((current) => {
                revokeOptimisticAttachments(current);
                return {
                  sessionId: selectedSessionId,
                  prompt,
                  attachments: createOptimisticAttachments(files)
                };
              });

              const attachments = await Promise.all(
                files.map(async (file) => {
                  const dataUrl = await readFileAsDataUrl(file);
                  return {
                    name: file.name || "image",
                    mimeType: file.type || "application/octet-stream",
                    dataUrl,
                    size: file.size
                  } satisfies ImageAttachmentInput;
                })
              );

              await runMutation.mutateAsync({
                prompt,
                attachments,
                codexSettings: currentRunSettings,
                clientSessionId: selectedSessionId
              });
            }}
            onRunSettingsChange={(settings) => {
              if (!selectedSessionId) {
                return;
              }
              setRunSettingsForSession(selectedSessionId, settings);
            }}
            onResetRunSettings={() => {
              if (!selectedSessionId) {
                return;
              }
              resetRunSettingsForSession(selectedSessionId);
            }}
            onSimulateCodexRequest={(scenario) => {
              if (!selectedSessionId || isDraftSession) {
                return Promise.resolve();
              }
              return simulateCodexRequestMutation
                .mutateAsync({
                  sessionId: selectedSessionId,
                  scenario
                })
                .then(() => undefined);
            }}
            onInterrupt={async () => {
              if (!interruptibleRunId) {
                return;
              }
              await interruptMutation.mutateAsync(interruptibleRunId);
            }}
            onRename={async () => {
              if (!actionableDetail || isDraftSession) {
                return;
              }

              const nextTitle = window.prompt("Rename session", actionableDetail.session.title)?.trim();
              if (!nextTitle || nextTitle === actionableDetail.session.title) {
                return;
              }

              await renameMutation.mutateAsync({
                sessionId: actionableDetail.session.id,
                title: nextTitle
              });
            }}
            onArchive={async () => {
              if (!actionableDetail || isDraftSession) {
                return;
              }

              const confirmed = window.confirm(`Archive "${actionableDetail.session.title}"?`);
              if (!confirmed) {
                return;
              }

              try {
                await archiveMutation.mutateAsync(actionableDetail.session.id);
              } catch (error) {
                window.alert(error instanceof Error ? error.message : "Unable to archive session.");
              }
            }}
            onRestore={async () => {
              if (!actionableDetail || isDraftSession) {
                return;
              }

              const confirmed = window.confirm(`Restore "${actionableDetail.session.title}"?`);
              if (!confirmed) {
                return;
              }

              try {
                await restoreMutation.mutateAsync(actionableDetail.session.id);
              } catch (error) {
                window.alert(error instanceof Error ? error.message : "Unable to restore session.");
              }
            }}
            isSubmitting={runMutation.isPending}
            isInterrupting={interruptMutation.isPending}
            isRenaming={renameMutation.isPending}
            isArchiving={archiveMutation.isPending}
            isRestoring={restoreMutation.isPending}
            isSimulatingCodexRequest={simulateCodexRequestMutation.isPending}
            simulateCodexRequestError={
              simulateCodexRequestMutation.error instanceof Error
                ? simulateCodexRequestMutation.error.message
                : null
            }
            canRename={!isDraftSession && hasResolvedSessionDetail}
            canArchive={!isDraftSession && hasResolvedSessionDetail && !(actionableDetail?.session.isArchived ?? false)}
            canRestore={!isDraftSession && hasResolvedSessionDetail && Boolean(actionableDetail?.session.isArchived)}
          />
        </section>
      </main>
    </div>
  );
}
