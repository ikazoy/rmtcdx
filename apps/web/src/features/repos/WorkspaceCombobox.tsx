import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Repository } from "@codex-remote/shared-types";
import { moveActiveItemKey, resolveActiveItemKey } from "../../components/listbox-navigation";
import { findLogicalRepoGroupByRepoId, groupByLogicalRepoLabel } from "./logical-repo-groups";

const EMPTY_OPTION_KEY = "__workspace-combobox-empty__";

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
  const [activeOptionKey, setActiveOptionKey] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const listboxId = useId();
  const repoGroups = useMemo(() => groupByLogicalRepoLabel(repos, formatRepoLabel), [formatRepoLabel, repos]);
  const selectedRepoGroup = useMemo(
    () => findLogicalRepoGroupByRepoId(repoGroups, selectedRepoId),
    [repoGroups, selectedRepoId]
  );
  const selectedRepo = selectedRepoGroup?.items[0] ?? null;
  const selectedLabel = selectedRepoGroup?.repoLabel ?? (emptyOptionLabel ?? "Select workspace");
  const selectedSecondaryLabel = selectedRepo && formatRepoSecondaryLabel ? formatRepoSecondaryLabel(selectedRepo) : null;
  const { filteredOptions, options } = useMemo(() => {
    const normalizedQuery = query.toLowerCase();
    const visibleRepoOptions = repoGroups
      .map((group) => {
        const representativeRepo = group.items[0];
        const secondaryLabel =
          representativeRepo && formatRepoSecondaryLabel ? formatRepoSecondaryLabel(representativeRepo) : null;
        return {
          key: group.repoKey,
          repoId: representativeRepo?.id ?? null,
          label: group.repoLabel,
          secondaryLabel,
          isSelected: Boolean(selectedRepoId && group.items.some((repo) => repo.id === selectedRepoId)),
          searchText: `${group.repoLabel.toLowerCase()} ${secondaryLabel?.toLowerCase() ?? ""}`
        };
      })
      .filter((option) => (normalizedQuery ? option.searchText.includes(normalizedQuery) : true));

    return {
      filteredOptions: visibleRepoOptions,
      options: [
        ...(emptyOptionLabel && !query
          ? [
              {
                key: EMPTY_OPTION_KEY,
                repoId: null,
                label: emptyOptionLabel,
                secondaryLabel: null,
                isSelected: selectedRepoId === null,
                searchText: ""
              }
            ]
          : []),
        ...visibleRepoOptions
      ]
    };
  }, [emptyOptionLabel, formatRepoSecondaryLabel, query, repoGroups, selectedRepoId]);
  const selectedOptionKey = options.find((option) => option.isSelected)?.key ?? null;
  const activeOption = options.find((option) => option.key === activeOptionKey) ?? null;
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
    const timeoutId = window.setTimeout(() => searchRef.current?.focus(), 50);
    return () => window.clearTimeout(timeoutId);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setActiveOptionKey(null);
      return;
    }

    setActiveOptionKey((current) =>
      resolveActiveItemKey({
        items: options,
        currentKey: current,
        preferredKey: selectedOptionKey
      })
    );
  }, [isOpen, options, selectedOptionKey]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !activeOptionKey) {
      return;
    }

    optionRefs.current.get(activeOptionKey)?.scrollIntoView({
      block: "nearest"
    });
  }, [activeOptionKey, isOpen]);

  function closeCombobox(restoreFocus = false) {
    setIsOpen(false);
    if (restoreFocus) {
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    }
  }

  function selectOption(repoId: string | null) {
    onSelectRepo(repoId);
    closeCombobox(true);
  }

  function moveActive(delta: -1 | 1) {
    setActiveOptionKey((current) =>
      moveActiveItemKey({
        items: options,
        currentKey: current ?? selectedOptionKey,
        delta
      })
    );
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        return;
      }

      moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      closeCombobox();
    }
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveActive(-1);
        break;
      case "Enter":
        if (activeOption) {
          event.preventDefault();
          selectOption(activeOption.repoId);
        }
        break;
      case "Escape":
        event.preventDefault();
        closeCombobox(true);
        break;
      default:
        break;
    }
  }

  return (
    <div className={rootClassName} ref={containerRef}>
      <button
        ref={triggerRef}
        className="combobox__trigger"
        type="button"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        onClick={() => setIsOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
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
              aria-controls={listboxId}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              autoComplete="off"
            />
          </div>

          <div className="combobox__list" id={listboxId} role="listbox">
            {options.map((option) => (
              <button
                key={option.key}
                ref={(node) => {
                  if (node) {
                    optionRefs.current.set(option.key, node);
                    return;
                  }

                  optionRefs.current.delete(option.key);
                }}
                className={`combobox__option ${option.isSelected ? "is-active" : ""} ${activeOptionKey === option.key ? "is-highlighted" : ""}`.trim()}
                role="option"
                aria-selected={option.isSelected}
                tabIndex={-1}
                onMouseEnter={() => setActiveOptionKey(option.key)}
                onClick={() => {
                  selectOption(option.repoId);
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
                    <span className="combobox__option-label">{option.label}</span>
                    {option.secondaryLabel ? <span className="combobox__option-meta">{option.secondaryLabel}</span> : null}
                  </span>
                ) : (
                  <span className="combobox__option-label">{option.label}</span>
                )}
              </button>
            ))}

            {query && filteredOptions.length === 0 ? <div className="combobox__empty">No matching workspaces</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
