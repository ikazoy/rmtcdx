import { useEffect, useRef, useState } from "react";
import type { Repository } from "@codex-remote/shared-types";

type Props = {
  repos: Repository[];
  selectedRepoId: string | null;
  formatRepoLabel: (repo: Repository) => string;
  formatRepoSecondaryLabel?: (repo: Repository) => string | null;
  onSelectRepo: (repoId: string | null) => void;
  emptyOptionLabel?: string | null;
  searchPlaceholder?: string;
  className?: string;
  layout?: "single-line" | "stacked";
};

export function WorkspaceCombobox({
  repos,
  selectedRepoId,
  formatRepoLabel,
  formatRepoSecondaryLabel,
  onSelectRepo,
  emptyOptionLabel = null,
  searchPlaceholder = "Search workspaces...",
  className,
  layout = "single-line"
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const selectedRepo = repos.find((repo) => repo.id === selectedRepoId) ?? null;
  const selectedLabel = selectedRepo ? formatRepoLabel(selectedRepo) : (emptyOptionLabel ?? "Select workspace");
  const selectedSecondaryLabel =
    selectedRepo && formatRepoSecondaryLabel ? formatRepoSecondaryLabel(selectedRepo) : null;
  const filteredRepos = query
    ? repos.filter((repo) => {
        const primary = formatRepoLabel(repo).toLowerCase();
        const secondary = formatRepoSecondaryLabel?.(repo)?.toLowerCase() ?? "";
        return `${primary} ${secondary}`.includes(query.toLowerCase());
      })
    : repos;
  const rootClassName = [
    "combobox",
    "combobox--inline",
    layout === "stacked" ? "combobox--stacked" : null,
    className ?? null
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setQuery("");
    window.setTimeout(() => searchRef.current?.focus(), 50);
  }, [isOpen]);

  return (
    <div className={rootClassName}>
      <button
        className="combobox__trigger"
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        {layout === "stacked" ? (
          <span className="combobox__trigger-copy">
            <span className="combobox__trigger-title">{selectedLabel}</span>
            {selectedSecondaryLabel ? <span className="combobox__trigger-meta">{selectedSecondaryLabel}</span> : null}
          </span>
        ) : (
          <span className="combobox__trigger-text">{selectedLabel}</span>
        )}
        <svg className="combobox__chevron" viewBox="0 0 16 16" fill="none">
          <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {isOpen ? (
        <div className="combobox__inline-body">
          <div className="combobox__search">
            <input
              ref={searchRef}
              className="combobox__search-input"
              type="text"
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoComplete="off"
            />
          </div>

          <div className="combobox__list" role="listbox">
            {emptyOptionLabel && !query ? (
              <button
                className={`combobox__option ${selectedRepoId === null ? "is-active" : ""}`}
                role="option"
                aria-selected={selectedRepoId === null}
                onClick={() => {
                  onSelectRepo(null);
                  setIsOpen(false);
                }}
                type="button"
              >
                <span className="combobox__option-check">
                  <svg viewBox="0 0 16 16" fill="none" width="16" height="16">
                    <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span className="combobox__option-label">{emptyOptionLabel}</span>
              </button>
            ) : null}

            {filteredRepos.map((repo) => {
              const secondaryLabel = formatRepoSecondaryLabel?.(repo) ?? null;

              return (
              <button
                key={repo.id}
                className={`combobox__option ${selectedRepoId === repo.id ? "is-active" : ""}`}
                role="option"
                aria-selected={selectedRepoId === repo.id}
                onClick={() => {
                  onSelectRepo(repo.id);
                  setIsOpen(false);
                }}
                type="button"
              >
                <span className="combobox__option-check">
                  <svg viewBox="0 0 16 16" fill="none" width="16" height="16">
                    <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                {layout === "stacked" ? (
                  <span className="combobox__option-copy">
                    <span className="combobox__option-label">{formatRepoLabel(repo)}</span>
                    {secondaryLabel ? <span className="combobox__option-meta">{secondaryLabel}</span> : null}
                  </span>
                ) : (
                  <span className="combobox__option-label">{formatRepoLabel(repo)}</span>
                )}
              </button>
              );
            })}

            {query && filteredRepos.length === 0 ? <div className="combobox__empty">No matching workspaces</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
