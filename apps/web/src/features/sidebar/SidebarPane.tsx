import type { Repository, SessionFilter, SessionSummary } from "../../../../../packages/shared-types/src/index";
import { SESSION_FILTERS } from "../../../../../packages/shared-types/src/index";
import { formatRelativeTime } from "../../components/formatters";
import { useUiStore } from "../../store/ui-store";

type Props = {
  repos: Repository[];
  selectedRepoId: string | null;
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  search: string;
  filter: SessionFilter;
  wsState: string;
  backendMode: "real" | "mock" | undefined;
  isCreatingSession: boolean;
  onSearchChange: (value: string) => void;
  onFilterChange: (value: SessionFilter) => void;
  onSelectRepo: (repoId: string | null) => void;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => void;
};

type RepoGroup = {
  repoName: string;
  sessions: SessionSummary[];
  latestUpdatedAt: string;
};

function getPreviewText(session: SessionSummary) {
  return session.latestAssistantExcerpt ?? session.latestUserPrompt ?? session.summary;
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
    case "error":
      return "Error";
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
      latestUpdatedAt: repoSessions[0]?.updatedAt ?? ""
    });
  }

  groups.sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt));
  return groups;
}

export function SidebarPane({
  repos,
  selectedRepoId,
  sessions,
  selectedSessionId,
  search,
  filter,
  isCreatingSession,
  onSearchChange,
  onFilterChange,
  onSelectRepo,
  onSelectSession,
  onCreateSession
}: Props) {
  const collapsedRepos = useUiStore((state) => state.collapsedRepos);
  const toggleRepoCollapsed = useUiStore((state) => state.toggleRepoCollapsed);

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

  const selectedRepo = orderedRepos.find((repo) => repo.id === selectedRepoId) ?? null;
  const repoGroups = selectedRepoId ? [] : groupByRepo(sessions);
  const singleRepoSessions = selectedRepoId ? sessions : [];

  return (
    <div className="sidebar-card">
      <div className="sidebar-brand">
        <h1>Threads</h1>
      </div>

      <label className="workspace-picker">
        <span>Workspace</span>
        <select
          value={selectedRepoId ?? ""}
          onChange={(event) => onSelectRepo(event.target.value || null)}
        >
          <option value="">All projects</option>
          {orderedRepos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {formatRepoLabel(repo)}
            </option>
          ))}
        </select>
      </label>

      {selectedRepo ? (
        <div className="sidebar-actions">
          <button
            className="action-button"
            disabled={isCreatingSession}
            onClick={onCreateSession}
            type="button"
          >
            {isCreatingSession ? "Creating..." : "New session"}
          </button>
        </div>
      ) : null}

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

      <div className="sidebar-controls">
        <label className="workspace-picker workspace-picker--compact">
          <span>State</span>
          <select value={filter} onChange={(event) => onFilterChange(event.target.value as SessionFilter)}>
            {SESSION_FILTERS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {filterLabel(candidate)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="sidebar-scroll">
        {repoGroups.length === 0 && singleRepoSessions.length === 0 ? (
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

        {/* All projects: group by repo */}
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
                      showRepo={false}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}

        {/* Single repo selected: flat list */}
        {singleRepoSessions.length > 0 ? (
          <div className="repo-group__list">
            {singleRepoSessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                isActive={selectedSessionId === session.id}
                onSelect={onSelectSession}
                showRepo={false}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  isActive,
  onSelect,
  showRepo
}: {
  session: SessionSummary;
  isActive: boolean;
  onSelect: (id: string) => void;
  showRepo: boolean;
}) {
  return (
    <button
      className={`session-row session-row--sidebar ${isActive ? "is-active" : ""}`}
      onClick={() => onSelect(session.id)}
      type="button"
    >
      <div className="session-row__head">
        <div className="session-row__titleline">
          <span className={`session-dot session-dot--${session.status}`} />
          <strong>{session.title}</strong>
        </div>
        <span className="session-row__time">{formatRelativeTime(session.updatedAt)}</span>
      </div>
      <p className="session-row__preview">{getPreviewText(session)}</p>
      <div className="session-row__meta">
        {showRepo && session.repoName ? <span>{session.repoName}</span> : null}
        {session.status === "running" ? <span className="badge">running</span> : null}
        {session.status === "error" || session.hasUnreadError ? (
          <span className="badge badge--error">error</span>
        ) : null}
        {session.hasUnreadCompletion ? <span className="badge">done</span> : null}
        {session.unreadCount > 0 ? <span className="badge">{session.unreadCount}</span> : null}
      </div>
    </button>
  );
}
