import { FloatingPortal } from "@floating-ui/react";
import { useEffect, useMemo, useState } from "react";
import type { Repository, SessionFilter, SessionSummary } from "@codex-remote/shared-types";
import { SESSION_FILTERS } from "@codex-remote/shared-types";
import type { SidebarViewState } from "../../app/view-state";
import { formatRelativeTime } from "../../components/formatters";
import { useAnchoredMenu } from "../../hooks/use-anchored-menu";
import {
  buildRepoNameFormatter,
  buildSessionRepoNameFormatter,
  buildSessionRepoVariantLabelFormatter,
  sortReposForDisplay
} from "../repos/repo-presentation";
import { groupByLogicalRepoLabel } from "../repos/logical-repo-groups";
import {
  DEFAULT_REPO_GROUP_VISIBLE_SESSION_LIMIT,
  getVisibleRepoGroupSessions,
  getRepoGroupIndicators,
  repoGroupToggleLabel,
  repoGroupIndicatorsLabel,
  shouldAutoExpandRepoGroup,
  shouldLimitRepoGroupSessions
} from "./repo-group-display";
import { WorkspaceCombobox } from "../repos/WorkspaceCombobox";
import { StatusMenu } from "../status/StatusMenu";
import { sessionDisplayStatus, sessionIndicatorTone } from "../sessions/session-state";
import { useUiStore } from "../../store/ui-store";

type Props = {
  repos: Repository[];
  isMobileViewport: boolean;
  selectedRepoId: string | null;
  sessionsState: SidebarViewState;
  selectedSessionId: string | null;
  selectedSessionPendingRequestCount: number;
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

const REFRESH_INDICATOR_DELAY_MS = 300;
const EMPTY_SESSIONS: SessionSummary[] = [];

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

export function SidebarPane({
  repos,
  isMobileViewport,
  selectedRepoId,
  sessionsState,
  selectedSessionId,
  selectedSessionPendingRequestCount,
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
  const [showRefreshIndicator, setShowRefreshIndicator] = useState(false);
  const [expandedRepoKeys, setExpandedRepoKeys] = useState<Set<string>>(() => new Set());
  const collapsedRepoKeys = useUiStore((state) => state.collapsedRepoKeys);
  const toggleRepoCollapsed = useUiStore((state) => state.toggleRepoCollapsed);
  const collapseRepos = useUiStore((state) => state.collapseRepos);
  const expandRepos = useUiStore((state) => state.expandRepos);
  const listMenu = useAnchoredMenu({
    open: isListMenuOpen,
    onOpenChange: setIsListMenuOpen
  });

  const orderedRepos = sortReposForDisplay(repos);
  const formatRepoName = buildRepoNameFormatter(orderedRepos);
  const formatSessionRepoName = buildSessionRepoNameFormatter(orderedRepos);
  const formatSessionRepoVariantLabel = buildSessionRepoVariantLabelFormatter(orderedRepos);

  const sessions = sessionsState.kind === "ready" ? sessionsState.sessions : EMPTY_SESSIONS;
  const isLoadingSessions = sessionsState.kind === "loading";
  const isRefreshingSessions = sessionsState.kind === "ready" && sessionsState.isRefreshing;
  const hasEmptyState = sessionsState.kind === "empty";
  const errorMessage = sessionsState.kind === "error" ? sessionsState.message : null;
  const selectedRepo = orderedRepos.find((repo) => repo.id === selectedRepoId) ?? null;
  const repoGroups = useMemo(
    () =>
      selectedRepoId
        ? []
        : groupByLogicalRepoLabel(sessions, formatSessionRepoName)
            .map((group) => ({
              repoKey: group.repoKey,
              repoLabel: group.repoLabel,
              sessions: group.items,
              latestSortAt: group.items[0] ? sessionSortAt(group.items[0]) : ""
            }))
            .sort((left, right) => right.latestSortAt.localeCompare(left.latestSortAt)),
    [formatSessionRepoName, selectedRepoId, sessions]
  );
  const shouldLimitGroupedSessions = shouldLimitRepoGroupSessions({
    selectedRepoId,
    search,
    filter
  });
  const singleRepoSessions = selectedRepoId ? sessions : [];
  const repoGroupKeys = repoGroups.map((group) => group.repoKey);
  const canToggleAllRepos = !selectedRepoId && repoGroupKeys.length > 0;
  const collapsedGroupCount = repoGroupKeys.filter((repoKey) => collapsedRepoKeys.has(repoKey)).length;
  const allReposCollapsed = canToggleAllRepos && collapsedGroupCount === repoGroupKeys.length;
  const selectedRepoLabel = selectedRepo ? formatRepoName(selectedRepo) : "All projects";
  const searchSummary = search.trim() ? `Search: ${search.trim()}` : null;

  useEffect(() => {
    if (!isRefreshingSessions) {
      setShowRefreshIndicator(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setShowRefreshIndicator(true);
    }, REFRESH_INDICATOR_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [isRefreshingSessions]);

  useEffect(() => {
    setExpandedRepoKeys((current) => {
      const validRepoKeys = new Set(repoGroups.map((group) => group.repoKey));
      const next = new Set<string>();
      let changed = false;

      for (const repoKey of current) {
        if (validRepoKeys.has(repoKey)) {
          next.add(repoKey);
        } else {
          changed = true;
        }
      }

      for (const group of repoGroups) {
        if (shouldAutoExpandRepoGroup(group.sessions, selectedSessionId) && !next.has(group.repoKey)) {
          next.add(group.repoKey);
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [repoGroups, selectedSessionId]);

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
      expandRepos(repoGroupKeys);
    } else {
      collapseRepos(repoGroupKeys);
    }

    closeListMenu();
  }

  function toggleRepoGroupExpansion(repoKey: string) {
    setExpandedRepoKeys((current) => {
      const next = new Set(current);
      if (next.has(repoKey)) {
        next.delete(repoKey);
      } else {
        next.add(repoKey);
      }
      return next;
    });
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
                <p className="sidebar-toolbar__summary">
                  <span className="sidebar-toolbar__repo">
                    <span className="sidebar-toolbar__repo-label">{selectedRepoLabel}</span>
                    <span
                      className={`sidebar-toolbar__sync-dot ${showRefreshIndicator ? "is-active" : ""}`}
                      aria-hidden="true"
                    />
                    <span className="sr-only">{showRefreshIndicator ? "Refreshing threads" : "Threads up to date"}</span>
                  </span>
                  {searchSummary ? <span className="sidebar-toolbar__search-summary"> · {searchSummary}</span> : null}
                </p>
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
                      <div className="chip-track">
                        {SESSION_FILTERS.map((candidate) => (
                          <button
                            key={candidate}
                            className={`chip ${candidate === filter ? "is-active" : ""}`}
                            onClick={() => {
                              onFilterChange(candidate);
                              closeListMenu();
                            }}
                            type="button"
                          >
                            {filterLabel(candidate)}
                          </button>
                        ))}
                      </div>
                    </section>

                    <section className="sidebar-menu__section">
                      <span className="sidebar-menu__section-title">Workspace</span>
                      <WorkspaceCombobox
                        repos={orderedRepos}
                        selectedRepoId={selectedRepoId}
                        formatRepoLabel={formatRepoName}
                        emptyOptionLabel="All projects"
                        onSelectRepo={(repoId) => {
                          onSelectRepo(repoId);
                          closeListMenu();
                        }}
                      />
                    </section>

                    <section className="sidebar-menu__section">
                      <span className="sidebar-menu__section-title">Search</span>
                      <div className="search-field search-field--sidebar">
                        <div className="search-field__wrapper">
                          <input
                            placeholder="Search threads..."
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
                      </div>
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
                const isCollapsed = collapsedRepoKeys.has(group.repoKey);
                const isExpanded = expandedRepoKeys.has(group.repoKey);
                const visibleSessions = shouldLimitGroupedSessions
                  ? getVisibleRepoGroupSessions(group.sessions, { isExpanded })
                  : group.sessions;
                const showGroupToggle = shouldLimitGroupedSessions && group.sessions.length > visibleSessions.length;
                const showCollapseToggle =
                  shouldLimitGroupedSessions
                  && group.sessions.length > DEFAULT_REPO_GROUP_VISIBLE_SESSION_LIMIT
                  && isExpanded;
                return (
                  <section key={group.repoKey} className="repo-group">
                    <button
                      className="repo-group__header"
                      onClick={() => toggleRepoCollapsed(group.repoKey)}
                      type="button"
                    >
                      <span className={`repo-group__chevron ${isCollapsed ? "is-collapsed" : ""}`}>▾</span>
                      <span className="repo-group__name">{group.repoLabel}</span>
                      <RepoGroupIndicators
                        indicators={getRepoGroupIndicators(group.sessions, {
                          selectedSessionId,
                          selectedSessionPendingRequestCount
                        })}
                      />
                      <span className="repo-group__count">{group.sessions.length}</span>
                    </button>
                    {!isCollapsed ? (
                      <>
                        <div className="repo-group__list">
                          {visibleSessions.map((session) => (
                            <SessionRow
                              key={session.id}
                              session={session}
                              isActive={selectedSessionId === session.id}
                              pendingRequestCount={Math.max(
                                session.pendingRequestCount,
                                selectedSessionId === session.id ? selectedSessionPendingRequestCount : 0
                              )}
                              onSelect={onSelectSession}
                              onHover={onHoverSession}
                              repoVariantLabel={formatSessionRepoVariantLabel(session)}
                            />
                          ))}
                        </div>
                        {showGroupToggle || showCollapseToggle ? (
                          <div className="repo-group__footer">
                            <button
                              className="repo-group__toggle"
                              onClick={() => toggleRepoGroupExpansion(group.repoKey)}
                              type="button"
                            >
                              {repoGroupToggleLabel({
                                totalCount: group.sessions.length,
                                visibleCount: visibleSessions.length
                              })}
                            </button>
                          </div>
                        ) : null}
                      </>
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
                      pendingRequestCount={Math.max(
                        session.pendingRequestCount,
                        selectedSessionId === session.id ? selectedSessionPendingRequestCount : 0
                      )}
                      onSelect={onSelectSession}
                      onHover={onHoverSession}
                      repoVariantLabel={null}
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

function RepoGroupIndicators({
  indicators
}: {
  indicators: ReturnType<typeof getRepoGroupIndicators>;
}) {
  const label = repoGroupIndicatorsLabel(indicators);

  if (indicators.length === 0) {
    return null;
  }

  return (
    <span className="repo-group__indicators">
      {label ? <span className="sr-only">{label}</span> : null}
      {indicators.map((indicator) => (
        <span
          key={indicator}
          className={`session-dot session-dot--${repoGroupIndicatorTone(indicator)} repo-group__indicator`}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}

function repoGroupIndicatorTone(indicator: ReturnType<typeof getRepoGroupIndicators>[number]) {
  switch (indicator) {
    case "unread":
      return "completed";
    case "error":
      return "error";
    case "pending":
      return "pending";
    case "running":
      return "running";
  }
}

function SessionRow({
  session,
  isActive,
  pendingRequestCount,
  onSelect,
  onHover,
  repoVariantLabel
}: {
  session: SessionSummary;
  isActive: boolean;
  pendingRequestCount: number;
  onSelect: (id: string) => void;
  onHover: (id: string) => void;
  repoVariantLabel: string | null;
}) {
  const displayStatus = sessionDisplayStatus(session);
  const indicatorTone = sessionIndicatorTone({
    ...session,
    pendingRequestCount
  });

  return (
    <button
      className={`session-row session-row--sidebar ${isActive ? "is-active" : ""}`}
      onClick={() => onSelect(session.id)}
      onMouseEnter={() => onHover(session.id)}
      type="button"
    >
      <div className="session-row__head">
        <div className="session-row__titleline">
          {indicatorTone !== "none" ? <span className={`session-dot session-dot--${indicatorTone}`} /> : null}
          <strong>{session.title}</strong>
        </div>
        <span className="session-row__time">{formatRelativeTime(sessionSortAt(session))}</span>
      </div>
      <p className="session-row__preview">{getPreviewText(session)}</p>
      <div className="session-row__meta">
        {repoVariantLabel ? <span>{repoVariantLabel}</span> : null}
        {displayStatus === "interrupted" ? (
          <span className="badge badge--interrupted">interrupted</span>
        ) : null}
        {session.hasUnreadError ? (
          <span className="badge badge--error">Attention</span>
        ) : displayStatus === "error" ? (
          <span className="badge badge--error">error</span>
        ) : null}
        {pendingRequestCount > 0 ? <span className="badge badge--pending">{pendingRequestCount} pending</span> : null}
      </div>
    </button>
  );
}
