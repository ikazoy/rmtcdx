import type { FileChangeEntry, Message } from "@codex-remote/shared-types";

export type FileDiffStat = {
  additions: number;
  deletions: number;
};

export type ThreadFileChangeEntry = FileChangeEntry & {
  firstPath: string;
  occurrenceCount: number;
  diffStat: FileDiffStat | null;
};

export type ThreadFileChangeSummary = {
  changes: ThreadFileChangeEntry[];
  count: number;
  rawCount: number;
};

function fileChangesFromMessage(message: Message) {
  return message.metadata?.type === "file_change" ? message.metadata.changes : [];
}

function fileChangeDisplayPath(change: Pick<FileChangeEntry, "path" | "movePath">) {
  return change.movePath ?? change.path;
}

export function summarizeUnifiedDiff(diff: string | undefined): FileDiffStat | null {
  if (!diff) {
    return null;
  }

  let additions = 0;
  let deletions = 0;

  for (const line of diff.split("\n")) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("@@") ||
      line.startsWith("+++ ") ||
      line.startsWith("--- ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("\\ No newline at end of file")
    ) {
      continue;
    }

    if (line.startsWith("+")) {
      additions += 1;
      continue;
    }

    if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  if (additions === 0 && deletions === 0) {
    return null;
  }

  return { additions, deletions };
}

export function summarizeThreadFileChanges(changes: FileChangeEntry[]): ThreadFileChangeSummary | null {
  if (changes.length === 0) {
    return null;
  }

  const grouped = new Map<
    string,
    {
      change: ThreadFileChangeEntry;
      firstSeenIndex: number;
      lastSeenIndex: number;
    }
  >();

  changes.forEach((change, index) => {
    const key = fileChangeDisplayPath(change);
    const existing = grouped.get(key);

    if (existing) {
      existing.change = {
        ...change,
        firstPath: existing.change.firstPath,
        occurrenceCount: existing.change.occurrenceCount + 1,
        diffStat: summarizeUnifiedDiff(change.diff)
      };
      existing.lastSeenIndex = index;
      return;
    }

    grouped.set(key, {
      change: {
        ...change,
        firstPath: change.path,
        occurrenceCount: 1,
        diffStat: summarizeUnifiedDiff(change.diff)
      },
      firstSeenIndex: index,
      lastSeenIndex: index
    });
  });

  const uniqueChanges = [...grouped.values()]
    .sort((left, right) => right.lastSeenIndex - left.lastSeenIndex || left.firstSeenIndex - right.firstSeenIndex)
    .map((entry) => entry.change);

  return {
    changes: uniqueChanges,
    count: uniqueChanges.length,
    rawCount: changes.length
  };
}

export function collectThreadFileChanges(messages: Message[]) {
  return summarizeThreadFileChanges(messages.flatMap((message) => fileChangesFromMessage(message)));
}
