import { startTransition, useDeferredValue, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { SessionFilter } from "../../../../packages/shared-types/src/index";
import { api } from "../api/client";
import { queryKeys } from "./query";
import { ChatPane } from "../features/chat/ChatPane";
import { RepoPane } from "../features/repos/RepoPane";
import { SessionsPane } from "../features/sessions/SessionsPane";
import { useRealtime } from "../hooks/use-realtime";
import { useUiStore } from "../store/ui-store";

export function App() {
  useRealtime();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<SessionFilter>("all");
  const deferredSearch = useDeferredValue(search);

  const selectedRepoId = useUiStore((state) => state.selectedRepoId);
  const selectedSessionId = useUiStore((state) => state.selectedSessionId);
  const mobilePane = useUiStore((state) => state.mobilePane);
  const wsState = useUiStore((state) => state.wsState);
  const backendBanner = useUiStore((state) => state.backendBanner);
  const setSelectedRepoId = useUiStore((state) => state.setSelectedRepoId);
  const setSelectedSessionId = useUiStore((state) => state.setSelectedSessionId);
  const setMobilePane = useUiStore((state) => state.setMobilePane);
  const streamingText = useUiStore((state) =>
    selectedSessionId ? state.streaming[selectedSessionId] ?? "" : ""
  );

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
    queryFn: () => api.sessions(selectedRepoId!, deferredSearch, filter),
    enabled: Boolean(selectedRepoId),
    refetchInterval: wsState === "connected" ? false : 5000
  });

  const sessionDetailQuery = useQuery({
    queryKey: queryKeys.session(selectedSessionId),
    queryFn: () => api.session(selectedSessionId!),
    enabled: Boolean(selectedSessionId)
  });

  const messagesQuery = useQuery({
    queryKey: queryKeys.messages(selectedSessionId),
    queryFn: () => api.messages(selectedSessionId!),
    enabled: Boolean(selectedSessionId)
  });

  useEffect(() => {
    const repos = reposQuery.data?.repos ?? [];
    const firstRepo = repos[0];
    if (!selectedRepoId && firstRepo) {
      setSelectedRepoId(firstRepo.id);
    }
  }, [reposQuery.data?.repos, selectedRepoId, setSelectedRepoId]);

  useEffect(() => {
    const sessions = sessionsQuery.data?.sessions ?? [];
    if (sessions.length === 0) {
      if (selectedSessionId) {
        setSelectedSessionId(null);
      }
      return;
    }

    const firstSession = sessions[0];
    if ((!selectedSessionId || !sessions.some((session) => session.id === selectedSessionId)) && firstSession) {
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

  const createSessionMutation = useMutation({
    mutationFn: () => api.createSession({ repoId: selectedRepoId! }),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      startTransition(() => {
        setSelectedSessionId(data.session.id);
        setMobilePane("chat");
      });
    }
  });

  const runMutation = useMutation({
    mutationFn: (prompt: string) => api.startRun({ sessionId: selectedSessionId!, prompt }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(selectedSessionId) });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    }
  });

  const interruptMutation = useMutation({
    mutationFn: (runId: string) => api.interruptRun(runId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(selectedSessionId) });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    }
  });

  const repos = reposQuery.data?.repos ?? [];
  const sessions = sessionsQuery.data?.sessions ?? [];
  const detail = sessionDetailQuery.data;
  const messages = messagesQuery.data?.messages ?? [];
  const selectedRepo = repos.find((repo) => repo.id === selectedRepoId) ?? null;

  const selectRepo = (repoId: string) => {
    startTransition(() => {
      setSelectedRepoId(repoId);
      setSelectedSessionId(null);
      setMobilePane("sessions");
    });
  };

  const selectSession = (sessionId: string) => {
    startTransition(() => {
      setSelectedSessionId(sessionId);
      setMobilePane("chat");
    });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Codex mobile remote</p>
          <h1>Remote control for the Mac mini harness</h1>
        </div>
        <div className="topbar__status">
          <span>{selectedRepo?.name ?? "No repo"}</span>
          <span>{healthQuery.data?.codex.mode ?? "..."}</span>
          <span>{wsState}</span>
        </div>
      </header>

      {backendBanner ? <div className="banner">{backendBanner}</div> : null}

      <div className="compact-repo-bar">
        {repos.map((repo) => (
          <button
            key={repo.id}
            className={`compact-repo-chip ${selectedRepoId === repo.id ? "is-active" : ""}`}
            onClick={() => selectRepo(repo.id)}
            type="button"
          >
            <strong>{repo.name}</strong>
            <span>{repo.branch ?? "branch?"}</span>
          </button>
        ))}
      </div>

      <main className="layout-grid">
        <section
          className="layout-pane layout-pane--repos mobile-toggle-hidden desktop-or-phone"
          data-mobile-visible={mobilePane === "repos"}
        >
          <RepoPane repos={repos} selectedRepoId={selectedRepoId} onSelect={selectRepo} />
        </section>

        <section
          className="layout-pane layout-pane--sessions mobile-toggle-hidden"
          data-mobile-visible={mobilePane === "sessions"}
        >
          <SessionsPane
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            search={search}
            filter={filter}
            onSearchChange={setSearch}
            onFilterChange={setFilter}
            onSelect={selectSession}
            onCreate={() => createSessionMutation.mutate()}
          />
        </section>

        <section
          className="layout-pane layout-pane--chat mobile-toggle-hidden"
          data-mobile-visible={mobilePane === "chat"}
        >
          <ChatPane
            detail={detail}
            messages={messages}
            streamingText={streamingText}
            wsState={wsState}
            backendMode={healthQuery.data?.codex.mode}
            onSubmit={async (prompt) => {
              await runMutation.mutateAsync(prompt);
            }}
            onInterrupt={async () => {
              if (!detail?.activeRun) {
                return;
              }
              await interruptMutation.mutateAsync(detail.activeRun.id);
            }}
            isSubmitting={runMutation.isPending}
            isInterrupting={interruptMutation.isPending}
          />
        </section>
      </main>

      <nav className="mobile-nav">
        <button className={mobilePane === "repos" ? "is-active" : ""} onClick={() => setMobilePane("repos")} type="button">
          Repos
        </button>
        <button
          className={mobilePane === "sessions" ? "is-active" : ""}
          onClick={() => setMobilePane("sessions")}
          type="button"
        >
          Sessions
        </button>
        <button className={mobilePane === "chat" ? "is-active" : ""} onClick={() => setMobilePane("chat")} type="button">
          Chat
        </button>
      </nav>
    </div>
  );
}
