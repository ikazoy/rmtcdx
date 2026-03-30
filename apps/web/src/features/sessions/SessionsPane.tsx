import type { SessionFilter, SessionSummary } from "@codex-remote/shared-types";
import { SESSION_FILTERS } from "@codex-remote/shared-types";
import { formatRelativeTime } from "../../components/formatters";
import { sessionDisplayStatus } from "./session-state";

type Props = {
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  search: string;
  filter: SessionFilter;
  onSearchChange: (value: string) => void;
  onFilterChange: (value: SessionFilter) => void;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
};

function sessionSortAt(session: SessionSummary) {
  return session.lastUserMessageAt ?? session.updatedAt;
}

export function SessionsPane({
  sessions,
  selectedSessionId,
  search,
  filter,
  onSearchChange,
  onFilterChange,
  onSelect,
  onCreate
}: Props) {
  return (
    <div className="pane-card">
      <div className="pane-head">
        <div>
          <p className="eyebrow">Sessions</p>
          <h2>Runs and unread completions</h2>
        </div>
        <button className="action-button" onClick={onCreate} type="button">
          New
        </button>
      </div>

      <label className="search-field">
        <span>Search</span>
        <input
          placeholder="Find test failures, refactors, fixes..."
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </label>

      <div className="filter-row">
        {SESSION_FILTERS.map((candidate) => (
          <button
            key={candidate}
            className={`filter-chip ${candidate === filter ? "is-active" : ""}`}
            onClick={() => onFilterChange(candidate)}
            type="button"
          >
            {candidate}
          </button>
        ))}
      </div>

      <div className="session-list">
        {sessions.length === 0 ? (
          <div className="empty-state">
            <strong>No sessions yet</strong>
            <p>Create a session or loosen the current search filter.</p>
          </div>
        ) : null}
        {sessions.map((session) => (
          <button
            key={session.id}
            className={`session-row ${selectedSessionId === session.id ? "is-active" : ""}`}
            onClick={() => onSelect(session.id)}
            type="button"
          >
            <div className="session-row__titleline">
              <span className={`session-dot session-dot--${sessionDisplayStatus(session)}`} />
              <strong>{session.title}</strong>
              {session.unreadCount > 0 ? <span className="badge">{session.unreadCount}</span> : null}
            </div>
            <p>{session.summary}</p>
            <div className="session-row__meta">
              <span>{sessionDisplayStatus(session)}</span>
              <span>{formatRelativeTime(sessionSortAt(session))}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
