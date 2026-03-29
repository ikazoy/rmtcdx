import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  ImageAttachmentInput,
  LiveActivity,
  Message,
  MessageAttachment,
  SessionDetail,
  SessionFilter
} from "../../../../packages/shared-types/src/index";
import { api } from "../api/client";
import { queryKeys } from "./query";
import { ChatPane } from "../features/chat/ChatPane";
import { SidebarPane } from "../features/sidebar/SidebarPane";
import { useRealtime } from "../hooks/use-realtime";
import { useUiStore } from "../store/ui-store";

const SIDEBAR_WIDTH_KEY = "codex-remote-sidebar-width";
const EMPTY_ACTIVITY_MAP: Record<string, LiveActivity> = {};

type OptimisticUserMessage = {
  sessionId: string;
  prompt: string;
  attachments: MessageAttachment[];
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

function clampSidebarWidth(width: number) {
  if (typeof window === "undefined") {
    return 308;
  }

  const maxWidth = Math.max(360, Math.min(520, window.innerWidth - 440));
  return Math.min(Math.max(width, 280), maxWidth);
}

export function App() {
  useRealtime();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [optimisticMessage, setOptimisticMessage] = useState<OptimisticUserMessage | null>(null);
  const optimisticMessageRef = useRef<OptimisticUserMessage | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === "undefined") {
      return 308;
    }

    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(stored) ? clampSidebarWidth(stored) : 308;
  });
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    optimisticMessageRef.current = optimisticMessage;
  }, [optimisticMessage]);

  useEffect(() => () => revokeOptimisticAttachments(optimisticMessageRef.current), []);

  const selectedRepoId = useUiStore((state) => state.selectedRepoId);
  const selectedSessionId = useUiStore((state) => state.selectedSessionId);
  const isDraftSession = Boolean(selectedSessionId?.startsWith("draft:"));
  const mobilePane = useUiStore((state) => state.mobilePane);
  const sidebarVisible = useUiStore((state) => state.sidebarVisible);
  const toggleSidebarVisible = useUiStore((state) => state.toggleSidebarVisible);
  const wsState = useUiStore((state) => state.wsState);
  const backendBanner = useUiStore((state) => state.backendBanner);
  const setSelectedRepoId = useUiStore((state) => state.setSelectedRepoId);
  const setSelectedSessionId = useUiStore((state) => state.setSelectedSessionId);
  const setMobilePane = useUiStore((state) => state.setMobilePane);
  const streamingText = useUiStore((state) =>
    selectedSessionId ? state.streaming[selectedSessionId] ?? "" : ""
  );
  const liveActivityMap = useUiStore((state) =>
    selectedSessionId ? state.activities[selectedSessionId] ?? EMPTY_ACTIVITY_MAP : EMPTY_ACTIVITY_MAP
  );
  const liveActivities = useMemo(() => Object.values(liveActivityMap), [liveActivityMap]);

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: api.health,
    refetchInterval: 15000
  });

  const reposQuery = useQuery({
    queryKey: queryKeys.repos,
    queryFn: api.repos
  });

  const sessionsQuery = useQuery({
    queryKey: queryKeys.sessions(selectedRepoId, deferredSearch, filter),
    queryFn: () => api.sessions(selectedRepoId, deferredSearch, filter),
    refetchInterval: 10000
  });

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

  useEffect(() => {
    const sessions = sessionsQuery.data?.sessions ?? [];
    if (sessions.length === 0) {
      return;
    }

    const firstSession = sessions[0];
    if (!selectedSessionId && firstSession) {
      setSelectedSessionId(firstSession.id);
    }
  }, [selectedSessionId, sessionsQuery.data?.sessions, setSelectedSessionId]);

  useEffect(() => {
    const sessions = sessionsQuery.data?.sessions ?? [];
    const unread = sessions.filter((session) => session.hasUnreadCompletion || session.hasUnreadError).length;
    document.title = unread > 0 ? `(${unread}) Codex Remote` : "Codex Remote";
  }, [sessionsQuery.data?.sessions]);

  useEffect(() => {
    const selected = sessionsQuery.data?.sessions.find((session) => session.id === selectedSessionId);
    if (selectedSessionId && selected?.unreadCount) {
      void api.markRead(selectedSessionId).catch(() => undefined);
    }
  }, [selectedSessionId, sessionsQuery.data?.sessions]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  const runMutation = useMutation({
    mutationFn: ({
      prompt,
      attachments
    }: {
      prompt: string;
      attachments: ImageAttachmentInput[];
      clientSessionId: string;
    }) =>
      api.startRun(
        isDraftSession
          ? { repoId: selectedRepoId!, prompt, attachments }
          : { sessionId: selectedSessionId!, prompt, attachments }
      ),
    onSuccess: async (data, variables) => {
      setOptimisticMessage((current) =>
        current && current.sessionId === variables.clientSessionId
          ? { ...current, sessionId: data.run.sessionId }
          : current
      );
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(data.run.sessionId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.messages(data.run.sessionId) });
      startTransition(() => {
        setSelectedSessionId(data.run.sessionId);
        setMobilePane("chat");
      });
    },
    onError: () => {
      setOptimisticMessage((current) => {
        revokeOptimisticAttachments(current);
        return null;
      });
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

  const repos = reposQuery.data?.repos ?? [];
  const sessions = sessionsQuery.data?.sessions ?? [];
  const selectedRepo = repos.find((repo) => repo.id === selectedRepoId) ?? null;
  const draftCreatedAt = new Date().toISOString();
  const draftDetail =
    isDraftSession && selectedRepo
      ? ({
          session: {
            id: selectedSessionId!,
            repoId: selectedRepo.id,
            repoName: selectedRepo.name,
            title: "New session",
            summary: `Start a conversation in ${selectedRepo.name}`,
            status: "idle",
            unreadCount: 0,
            lastEventSeq: 0,
            lastReadEventSeq: 0,
            lastMessageAt: draftCreatedAt,
            hasUnreadCompletion: false,
            hasUnreadError: false,
            createdAt: draftCreatedAt,
            updatedAt: draftCreatedAt
          },
          activeRun: null,
          latestRun: null
        } satisfies SessionDetail)
      : null;
  const detail = isDraftSession ? draftDetail : sessionDetailQuery.data;
  const messages = isDraftSession ? [] : messagesQuery.data?.messages ?? [];
  const activeRepoName = selectedRepo?.name ?? detail?.session.repoName;
  const optimisticMessageForSession =
    optimisticMessage && optimisticMessage.sessionId === selectedSessionId ? optimisticMessage : null;

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

  const selectRepo = (repoId: string | null) => {
    startTransition(() => {
      setSelectedRepoId(repoId);
      setSelectedSessionId(null);
      setMobilePane("sidebar");
    });
  };

  const selectSession = (sessionId: string) => {
    startTransition(() => {
      setSelectedSessionId(sessionId);
      setMobilePane("chat");
    });
  };

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.innerWidth < 860) {
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

  return (
    <div className={`app-shell ${isResizingSidebar ? "is-resizing" : ""}`}>
      {backendBanner ? <div className="banner">{backendBanner}</div> : null}

      <main className="workspace-shell" data-sidebar-hidden={!sidebarVisible} style={workspaceStyle}>
        <aside className="workspace-shell__sidebar" data-mobile-visible={mobilePane !== "chat"}>
          <SidebarPane
            repos={repos}
            selectedRepoId={selectedRepoId}
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            search={search}
            filter={filter}
            wsState={wsState}
            backendMode={healthQuery.data?.codex.mode}
            onSearchChange={setSearch}
            onFilterChange={setFilter}
            onSelectRepo={selectRepo}
            onSelectSession={selectSession}
            isCreatingSession={false}
            onCreateSession={() => {
              if (!selectedRepoId) {
                return;
              }
              startTransition(() => {
                setSelectedSessionId(`draft:${selectedRepoId}:${Date.now()}`);
                setMobilePane("chat");
              });
            }}
          />
        </aside>

        <div
          className="workspace-shell__resizer"
          onPointerDown={startSidebarResize}
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={280}
          aria-valuemax={520}
          aria-valuenow={sidebarWidth}
          tabIndex={-1}
        />

        <section className="workspace-shell__chat" data-mobile-visible={mobilePane === "chat"}>
          <ChatPane
            detail={detail}
            messages={messages}
            streamingText={streamingText}
            liveActivities={liveActivities}
            optimisticMessage={optimisticMessageForSession}
            wsState={wsState}
            backendMode={healthQuery.data?.codex.mode}
            repoName={activeRepoName}
            onBack={() => setMobilePane("sidebar")}
            onToggleSidebar={toggleSidebarVisible}
            onSubmit={async ({ prompt, files }) => {
              if (!selectedSessionId) {
                return;
              }

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

              setOptimisticMessage((current) => {
                revokeOptimisticAttachments(current);
                return {
                  sessionId: selectedSessionId,
                  prompt,
                  attachments: createOptimisticAttachments(files)
                };
              });

              await runMutation.mutateAsync({
                prompt,
                attachments,
                clientSessionId: selectedSessionId
              });
            }}
            onInterrupt={async () => {
              if (!detail?.activeRun) {
                return;
              }
              await interruptMutation.mutateAsync(detail.activeRun.id);
            }}
            onRename={async () => {
              if (!detail || isDraftSession) {
                return;
              }

              const nextTitle = window.prompt("Rename session", detail.session.title)?.trim();
              if (!nextTitle || nextTitle === detail.session.title) {
                return;
              }

              await renameMutation.mutateAsync({
                sessionId: detail.session.id,
                title: nextTitle
              });
            }}
            isSubmitting={runMutation.isPending}
            isInterrupting={interruptMutation.isPending}
            isRenaming={renameMutation.isPending}
            canRename={!isDraftSession}
          />
        </section>
      </main>
    </div>
  );
}
