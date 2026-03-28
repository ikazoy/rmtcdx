import type { Repository } from "../../../../../packages/shared-types/src/index";
import { formatRelativeTime } from "../../components/formatters";

type Props = {
  repos: Repository[];
  selectedRepoId: string | null;
  onSelect: (repoId: string) => void;
};

export function RepoPane({ repos, selectedRepoId, onSelect }: Props) {
  return (
    <div className="pane-card">
      <div className="pane-head">
        <div>
          <p className="eyebrow">Repositories</p>
          <h2>Pinned workspaces</h2>
        </div>
      </div>
      <div className="repo-list">
        {repos.map((repo) => (
          <button
            key={repo.id}
            className={`repo-card ${selectedRepoId === repo.id ? "is-active" : ""}`}
            onClick={() => onSelect(repo.id)}
            type="button"
          >
            <div className="repo-card__header">
              <strong>{repo.name}</strong>
              {repo.pinned ? <span className="pin">Pinned</span> : null}
            </div>
            <p>{repo.description ?? repo.path}</p>
            <div className="repo-card__meta">
              <span>{repo.branch ?? "no branch"}</span>
              <span>{repo.runningSessionCount} running</span>
              <span>{formatRelativeTime(repo.updatedAt)}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
