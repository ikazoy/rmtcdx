import type { FileChangeEntry, Message } from "@codex-remote/shared-types";

export type ThreadFileChangeEntry = FileChangeEntry & {
  firstPath: string;
  occurrenceCount: number;
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
        occurrenceCount: existing.change.occurrenceCount + 1
      };
      existing.lastSeenIndex = index;
      return;
    }

    grouped.set(key, {
      change: {
        ...change,
        firstPath: change.path,
        occurrenceCount: 1
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
