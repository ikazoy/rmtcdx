import type { FileSelection } from "@codex-remote/shared-types";

export type ParsedLocalFileHref = {
  path: string;
  selection: FileSelection | null;
};

const githubSelectionPattern =
  /^L(?<startLine>\d+)(?:C(?<startColumn>\d+))?(?:-L?(?<endLine>\d+)(?:C(?<endColumn>\d+))?)?$/i;
const colonSelectionPattern =
  /:(?<startLine>\d+)(?::(?<startColumn>\d+))?(?:-(?<endLine>\d+)(?::(?<endColumn>\d+))?)?$/;

function parsePositiveInteger(value: string | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

export function normalizeFileSelection(selection: FileSelection | null | undefined): FileSelection | null {
  if (!selection) {
    return null;
  }

  const startLine = parsePositiveInteger(String(selection.startLine));
  const endLine = selection.endLine == null ? null : parsePositiveInteger(String(selection.endLine));
  const startColumn = selection.startColumn == null ? null : parsePositiveInteger(String(selection.startColumn));
  const endColumn = selection.endColumn == null ? null : parsePositiveInteger(String(selection.endColumn));

  if (!startLine) {
    return null;
  }

  const normalizedEndLine = endLine && endLine >= startLine ? endLine : null;
  const normalizedStartColumn = startColumn ?? null;
  const normalizedEndColumn =
    endColumn && (normalizedEndLine !== null || normalizedStartColumn !== null) ? endColumn : null;

  return {
    startLine,
    endLine: normalizedEndLine,
    startColumn: normalizedStartColumn,
    endColumn: normalizedEndColumn
  };
}

function selectionFromMatch(groups: Record<string, string | undefined>) {
  const normalized = normalizeFileSelection({
    startLine: parsePositiveInteger(groups.startLine ?? "") ?? 0,
    endLine: parsePositiveInteger(groups.endLine ?? ""),
    startColumn: parsePositiveInteger(groups.startColumn ?? ""),
    endColumn: parsePositiveInteger(groups.endColumn ?? "")
  });

  return normalized;
}

function parseSelectionFragment(fragment: string) {
  const decodedFragment = safeDecodeURIComponent(fragment.trim());
  if (!decodedFragment) {
    return null;
  }

  const matched = decodedFragment.match(githubSelectionPattern);
  if (!matched?.groups) {
    return null;
  }

  return selectionFromMatch(matched.groups);
}

function parseColonSelection(pathWithSelection: string) {
  const matched = pathWithSelection.match(colonSelectionPattern);
  if (!matched?.groups || matched.index == null) {
    return null;
  }

  const path = pathWithSelection.slice(0, matched.index);
  if (!path) {
    return null;
  }

  const selection = selectionFromMatch(matched.groups);
  if (!selection) {
    return null;
  }

  return { path, selection };
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseLocalFileHref(href: string): ParsedLocalFileHref | null {
  const candidate = href.trim();
  if (!candidate || candidate.startsWith("#")) {
    return null;
  }

  if (/^(https?:|mailto:|tel:)/i.test(candidate)) {
    return null;
  }

  let pathWithSelection = candidate;
  let selection: FileSelection | null = null;

  const hashIndex = candidate.indexOf("#");
  if (hashIndex >= 0) {
    pathWithSelection = candidate.slice(0, hashIndex);
    selection = parseSelectionFragment(candidate.slice(hashIndex + 1));
  }

  let path = pathWithSelection;

  if (candidate.startsWith("file://")) {
    try {
      path = safeDecodeURIComponent(new URL(candidate).pathname);
    } catch {
      return null;
    }
  } else if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(pathWithSelection)) {
    return null;
  } else {
    path = safeDecodeURIComponent(pathWithSelection);
  }

  if (!selection) {
    const colonSelection = parseColonSelection(path);
    if (colonSelection) {
      path = colonSelection.path;
      selection = colonSelection.selection;
    }
  }

  if (!path) {
    return null;
  }

  return {
    path,
    selection: normalizeFileSelection(selection)
  };
}

export function formatFileSelectionSuffix(selection: FileSelection | null | undefined) {
  const normalized = normalizeFileSelection(selection);
  if (!normalized) {
    return "";
  }

  const start = `L${normalized.startLine}${normalized.startColumn ? `C${normalized.startColumn}` : ""}`;

  if (normalized.endLine == null && normalized.endColumn == null) {
    return `#${start}`;
  }

  const endLine = normalized.endLine ?? normalized.startLine;
  const end = `L${endLine}${normalized.endColumn ? `C${normalized.endColumn}` : ""}`;
  return `#${start}-${end}`;
}

export function fileSelectionLineRange(selection: FileSelection | null | undefined) {
  const normalized = normalizeFileSelection(selection);
  if (!normalized) {
    return null;
  }

  return {
    startLine: normalized.startLine,
    endLine: normalized.endLine ?? normalized.startLine
  };
}
