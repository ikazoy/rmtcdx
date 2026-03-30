import { FloatingPortal } from "@floating-ui/react";
import { useState } from "react";
import type { Repository, SessionFilter, SessionSummary } from "@codex-remote/shared-types";
import { SESSION_FILTERS } from "@codex-remote/shared-types";
import type { SidebarViewState } from "../../app/view-state";
import { formatRelativeTime } from "../../components/formatters";
import { useAnchoredMenu } from "../../hooks/use-anchored-menu";
import { StatusMenu } from "../status/StatusMenu";
import { sessionDisplayStatus } from "../sessions/session-state";
import { useUiStore } from "../../store/ui-store";

type Props = {
  repos: Repository[];
  isMobileViewport: boolean;
  selectedRepoId: string | null;
  sessionsState: SidebarViewState;
  selectedSessionId: string | null;
  search: string;
  filter: SessionFilter;
  wsState: string;
  backendMode: "real" | "mock" | undefined;
  isCreatingSession: boolean;
  canCreateSession: boolean;
  onSearchChange: (value: string) => void;
  onFilterChange: (value: SessionFilter) => void;
  onSelectRepo: (repoId: string | null) => void;
  onSelectSession: (sessionId: string) => void;
  onToggleSidebar: () => void;
  onHoverSession: (sessionId: string) => void;
  onCreateSession: () => void;
};

type RepoGroup = {
  repoName: string;
  sessions: SessionSummary[];
  latestSortAt: string;
};

function getPreviewText(session: SessionSummary) {
  return session.latestAssistantExcerpt ?? session.latestUserPrompt ?? session.summary;
}

function sessionSortAt(session: SessionSummary) {
  return session.lastUserMessageAt ?? session.updatedAt;
}

function filterLabel(filter: SessionFilter) {
  switch (filter) {
    case "all":
      return "All threads";
    case "running":
      return "Running";
    case "unread":
      return "Unread";
    case "completed":
      return "Completed";
    case "interrupted":
      return "Interrupted";
    case "error":
      return "Error";
    case "archived":
      return "Archived";
  }
}

function groupByRepo(sessions: SessionSummary[]): RepoGroup[] {
  const map = new Map<string, SessionSummary[]>();

  for (const session of sessions) {
    const key = session.repoName ?? "Unknown";
    const list = map.get(key);
    if (list) {
      list.push(session);
    } else {
      map.set(key, [session]);
    }
  }

  const groups: RepoGroup[] = [];
  for (const [repoName, repoSessions] of map) {
    groups.push({
      repoName,
      sessions: repoSessions,
      latestSortAt: repoSessions[0] ? sessionSortAt(repoSessions[0]) : ""
    });
  }

  groups.sort((a, b) => b.latestSortAt.localeCompare(a.latestSortAt));
  return groups;
}

export function SidebarPane({
  repos,
  isMobileViewport,
  selectedRepoId,
  sessionsState,
  selectedSessionId,
  search,
  filter,
  isCreatingSession,
  canCreateSession,
  onSearchChange,
  onFilterChange,
  onSelectRepo,
  onSelectSession,
  onToggleSidebar,
  onHoverSession,
  onCreateSession
}: Props) {
  const [isListMenuOpen, setIsListMenuOpen] = useState(false);
  const collapsedRepos = useUiStore((state) => state.collapsedRepos);
  const toggleRepoCollapsed = useUiStore((state) => state.toggleRepoCollapsed);
  const collapseRepos = useUiStore((state) => state.collapseRepos);
  const expandRepos = useUiStore((state) => state.expandRepos);
  const listMenu = useAnchoredMenu({
    open: isListMenuOpen,
    onOpenChange: setIsListMenuOpen
  });

  const orderedRepos = [...repos].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  const nameCounts = orderedRepos.reduce<Map<string, number>>((counts, repo) => {
    counts.set(repo.name, (counts.get(repo.name) ?? 0) + 1);
    return counts;
  }, new Map());
  const duplicateNames = new Set(
    [...nameCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name)
  );

  function formatRepoLabel(repo: Repository) {
    if (!duplicateNames.has(repo.name)) {
      return repo.name;
    }
    const segment = repo.path.split("/").filter(Boolean).at(-1) ?? repo.path;
    return repo.branch ? `${repo.name} · ${repo.branch}` : `${repo.name} · ${segment}`;
  }

  const sessions = sessionsState.kind === "ready" ? sessionsState.sessions : [];
  const isLoadingSessions = sessionsState.kind === "loading";
  const isRefreshingSessions = sessionsState.kind === "ready" && sessionsState.isRefreshing;
  const hasEmptyState = sessionsState.kind === "empty";
  const errorMessage = sessionsState.kind === "error" ? sessionsState.message : null;
  const selectedRepo = orderedRepos.find((repo) => repo.id === selectedRepoId) ?? null;
  const repoGroups = selectedRepoId ? [] : groupByRepo(sessions);
  const singleRepoSessions = selectedRepoId ? sessions : [];
  const repoGroupNames = repoGroups.map((group) => group.repoName);
  const canToggleAllRepos = !selectedRepoId && repoGroupNames.length > 0;
  const collapsedGroupCount = repoGroupNames.filter((repoName) => collapsedRepos.has(repoName)).length;
  const allReposCollapsed = canToggleAllRepos && collapsedGroupCount === repoGroupNames.length;
  const activeSummary = [
    selectedRepo ? formatRepoLabel(selectedRepo) : "All projects",
    search.trim() ? `Search: ${search.trim()}` : null
  ]
    .filter(Boolean)
    .join(" · ");

  function closeListMenu() {
    setIsListMenuOpen(false);
  }

  function handleToggleSidebar() {
    closeListMenu();
    onToggleSidebar();
  }

  function handleToggleAllRepos() {
    if (!canToggleAllRepos) {
      return;
    }

    if (allReposCollapsed) {
      expandRepos(repoGroupNames);
    } else {
      collapseRepos(repoGroupNames);
    }

    closeListMenu();
  }

  return (
    <div className="sidebar-shell">
      <div className="sidebar-rail">
        <button
          className="sidebar-toggle sidebar-toggle--rail"
          onClick={handleToggleSidebar}
          type="button"
          aria-label="Open sidebar"
          title="Open sidebar"
        >
          <SidebarToggleIcon collapsed />
        </button>
      </div>

      <div className="sidebar-card">
        <div className="sidebar-brand">
          <div className="sidebar-brand__lead">
            <div className="sidebar-brand__copy">
              <div className="sidebar-brand__headline">
                <h1>Threads</h1>
                <p className="sidebar-toolbar__summary">{activeSummary}</p>
                {filter !== "all" ? <span className="sidebar-brand__state">{filterLabel(filter)}</span> : null}
              </div>
            </div>
          </div>

          <div className="sidebar-brand__actions">
            <StatusMenu isMobileViewport={isMobileViewport} />

            <button
              className="sidebar-menu__trigger"
              onClick={handleToggleAllRepos}
              type="button"
              disabled={!canToggleAllRepos}
              aria-pressed={canToggleAllRepos ? allReposCollapsed : undefined}
              aria-label={
                canToggleAllRepos
                  ? (allReposCollapsed ? "Expand all repos" : "Collapse all repos")
                  : "Collapse all repos unavailable"
              }
              title={
                canToggleAllRepos
                  ? (allReposCollapsed ? "Expand all repos" : "Collapse all repos")
                  : "Collapse all repos is available in All projects view"
              }
            >
              <span className="sr-only">
                {canToggleAllRepos
                  ? (allReposCollapsed ? "Expand all repos" : "Collapse all repos")
                  : "Collapse all repos unavailable"}
              </span>
              <RepoGroupToggleIcon collapsed={allReposCollapsed} />
            </button>

            <div className="sidebar-menu">
              <button
                ref={listMenu.refs.setReference}
                {...listMenu.getReferenceProps({
                  className: "sidebar-menu__trigger",
                  type: "button",
                  "aria-expanded": isListMenuOpen,
                  "aria-label": "Open list options"
                })}
              >
                <span className="sr-only">Open list options</span>
                <svg
                  className="sidebar-menu__trigger-icon"
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path d="M4 7H14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M10 17H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <circle cx="17" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.8" />
                  <circle cx="7" cy="17" r="2.2" stroke="currentColor" strokeWidth="1.8" />
                </svg>
              </button>

              {isListMenuOpen ? (
                <FloatingPortal>
                  <div
                    ref={listMenu.refs.setFloating}
                    className="sidebar-menu__popover sidebar-menu__popover--sidebar"
                    style={listMenu.floatingStyles}
                    {...listMenu.getFloatingProps()}
                  >
                    <section className="sidebar-menu__section">
                      <span className="sidebar-menu__section-title">State</span>
                      <div className="sidebar-menu__list">
                        {SESSION_FILTERS.map((candidate) => {
                          const isActive = candidate === filter;
                          return (
                            <button
                              key={candidate}
                              className={`sidebar-menu__item ${isActive ? "is-active" : ""}`}
                              onClick={() => {
                                onFilterChange(candidate);
                                closeListMenu();
                              }}
                              type="button"
                            >
                              <span>{filterLabel(candidate)}</span>
                              <span
                                className={`sidebar-menu__check ${isActive ? "is-visible" : ""}`}
                                aria-hidden="true"
                              />
                            </button>
                          );
                        })}
                      </div>
                    </section>

                    <section className="sidebar-menu__section">
                      <label className="workspace-picker">
                        <span>Workspace</span>
                        <select
                          value={selectedRepoId ?? ""}
                          onChange={(event) => {
                            onSelectRepo(event.target.value || null);
                            closeListMenu();
                          }}
                        >
                          <option value="">All projects</option>
                          {orderedRepos.map((repo) => (
                            <option key={repo.id} value={repo.id}>
                              {formatRepoLabel(repo)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </section>

                    <section className="sidebar-menu__section">
                      <label className="search-field search-field--sidebar">
                        <span>Search threads</span>
                        <div className="search-field__wrapper">
                          <input
                            placeholder="Search..."
                            value={search}
                            onChange={(event) => onSearchChange(event.target.value)}
                          />
                          {search ? (
                            <button
                              className="search-field__clear"
                              onClick={() => onSearchChange("")}
                              type="button"
                              aria-label="Clear search"
                            >
                              ×
                            </button>
                          ) : null}
                        </div>
                      </label>
                    </section>

                  </div>
                </FloatingPortal>
              ) : null}
            </div>

            <button
              className="sidebar-toggle"
              onClick={handleToggleSidebar}
              type="button"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
            >
              <SidebarToggleIcon />
            </button>
          </div>
        </div>

        <div className="sidebar-scroll">
          {isRefreshingSessions ? <p className="sidebar-loading-note">Refreshing threads…</p> : null}

          {isLoadingSessions ? (
            <SidebarSkeleton />
          ) : null}

          {errorMessage ? (
            <div className="empty-state empty-state--sidebar">
              <strong>Unable to load threads</strong>
              <p>{errorMessage}</p>
            </div>
          ) : null}

          {hasEmptyState ? (
            <div className="empty-state empty-state--sidebar">
              <strong>{search || filter !== "all" ? "No matching sessions" : "No sessions yet"}</strong>
              <p>
                {search || filter !== "all"
                  ? "Try a different search term or filter."
                  : selectedRepo
                    ? "Create a session and start a run."
                    : "Pick a project to start a new thread."}
              </p>
            </div>
          ) : null}

          {!isLoadingSessions && !errorMessage ? (
            <>
              {repoGroups.map((group) => {
                const isCollapsed = collapsedRepos.has(group.repoName);
                return (
                  <section key={group.repoName} className="repo-group">
                    <button
                      className="repo-group__header"
                      onClick={() => toggleRepoCollapsed(group.repoName)}
                      type="button"
                    >
                      <span className={`repo-group__chevron ${isCollapsed ? "is-collapsed" : ""}`}>▾</span>
                      <span className="repo-group__name">{group.repoName}</span>
                      <span className="repo-group__count">{group.sessions.length}</span>
                    </button>
                    {!isCollapsed ? (
                      <div className="repo-group__list">
                        {group.sessions.map((session) => (
                          <SessionRow
                            key={session.id}
                            session={session}
                            isActive={selectedSessionId === session.id}
                            onSelect={onSelectSession}
                            onHover={onHoverSession}
                            showRepo={false}
                          />
                        ))}
                      </div>
                    ) : null}
                  </section>
                );
              })}

              {singleRepoSessions.length > 0 ? (
                <div className="repo-group__list">
                  {singleRepoSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      isActive={selectedSessionId === session.id}
                      onSelect={onSelectSession}
                      onHover={onHoverSession}
                      showRepo={false}
                    />
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="sidebar-footer">
          <button
            className="sidebar-fab"
            disabled={!canCreateSession || isCreatingSession}
            onClick={onCreateSession}
            type="button"
            title={canCreateSession ? "Create a new session" : "No workspace available"}
          >
            {isCreatingSession ? "Creating..." : "+ New session"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SidebarSkeleton() {
  return (
    <div className="repo-group__list sidebar-skeleton" aria-hidden="true">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="session-row session-row--sidebar sidebar-skeleton__row">
          <div className="session-row__head">
            <div className="session-row__titleline sidebar-skeleton__titleline">
              <span className="skeleton sidebar-skeleton__dot" />
              <div className="skeleton skeleton--title sidebar-skeleton__title" />
            </div>
            <div className="skeleton skeleton--subtitle sidebar-skeleton__time" />
          </div>
          <div className="skeleton skeleton--subtitle sidebar-skeleton__preview" />
          <div className="skeleton skeleton--subtitle sidebar-skeleton__meta" />
        </div>
      ))}
    </div>
  );
}

function SidebarToggleIcon({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <svg
      className="sidebar-toggle__icon"
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M5 4.25V15.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {collapsed ? (
        <path d="M8 6.5L11.75 10L8 13.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path
          d="M12 6.5L8.25 10L12 13.5"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function RepoGroupToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className="sidebar-menu__trigger-icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M5 8.25H11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M5 12H15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M5 15.75H11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      {collapsed ? (
        <>
          <path d="M14 9.5L17 12.5L20 9.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M17 5.5V12.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
      ) : (
        <>
          <path d="M14 14.5L17 11.5L20 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M17 18.5V11.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

function SessionRow({
  session,
  isActive,
  onSelect,
  onHover,
  showRepo
}: {
  session: SessionSummary;
  isActive: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string) => void;
  showRepo: boolean;
}) {
  const displayStatus = sessionDisplayStatus(session);

  return (
    <button
      className={`session-row session-row--sidebar ${isActive ? "is-active" : ""}`}
      onClick={() => onSelect(session.id)}
      onMouseEnter={() => onHover(session.id)}
      type="button"
    >
      <div className="session-row__head">
        <div className="session-row__titleline">
          <span className={`session-dot session-dot--${displayStatus}`} />
          <strong>{session.title}</strong>
        </div>
        <span className="session-row__time">{formatRelativeTime(sessionSortAt(session))}</span>
      </div>
      <p className="session-row__preview">{getPreviewText(session)}</p>
      <div className="session-row__meta">
        {showRepo && session.repoName ? <span>{session.repoName}</span> : null}
        {displayStatus === "interrupted" ? (
          <span className="badge badge--interrupted">interrupted</span>
        ) : null}
        {displayStatus === "error" || session.hasUnreadError ? (
          <span className="badge badge--error">error</span>
        ) : null}
        {session.unreadCount > 0 ? <span className="badge">{session.unreadCount}</span> : null}
      </div>
    </button>
  );
}
