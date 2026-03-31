import fs from "node:fs";
import path from "node:path";

import type { SessionDetail, SessionSummary } from "@codex-remote/shared-types";
import { nowIso } from "../utils/time";

type UnreadKind = "completion" | "error";

type StoredUnreadEntry = {
  seq: number;
  kind: UnreadKind;
  turnId: string;
  runId?: string;
  createdAt: string;
};

type StoredSessionUnreadState = {
  lastEventSeq: number;
  lastReadEventSeq: number;
  unread: StoredUnreadEntry[];
  updatedAt: string;
};

type StoredUnreadStateFile = {
  version: 1;
  sessions: Record<string, StoredSessionUnreadState>;
};

type PendingCompletion = {
  sessionId: string;
  runId: string;
  turnId: string;
  createdAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUnreadKind(value: unknown): value is UnreadKind {
  return value === "completion" || value === "error";
}

function normalizeUnreadEntry(value: unknown): StoredUnreadEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawSeq = value.seq;
  const kind = value.kind;
  const turnId = value.turnId;
  const runId = value.runId;
  const createdAt = value.createdAt;
  const seq = typeof rawSeq === "number" && Number.isInteger(rawSeq) ? rawSeq : null;

  if (
    seq === null
    || seq < 1
    || !isUnreadKind(kind)
    || typeof turnId !== "string"
    || !turnId
    || typeof createdAt !== "string"
    || !createdAt
  ) {
    return null;
  }

  return {
    seq,
    kind,
    turnId,
    runId: typeof runId === "string" && runId ? runId : undefined,
    createdAt
  };
}

function normalizeSessionState(value: unknown): StoredSessionUnreadState | null {
  if (!isRecord(value)) {
    return null;
  }

  const unreadRaw = Array.isArray(value.unread) ? value.unread : [];
  const unread = unreadRaw
    .map((entry) => normalizeUnreadEntry(entry))
    .filter((entry): entry is StoredUnreadEntry => Boolean(entry))
    .sort((left, right) => left.seq - right.seq);
  const maxSeq = unread.at(-1)?.seq ?? 0;
  const parsedLastEventSeq = Number.isInteger(value.lastEventSeq) && (value.lastEventSeq as number) >= 0
    ? (value.lastEventSeq as number)
    : 0;
  const lastEventSeq = Math.max(parsedLastEventSeq, maxSeq);
  const parsedLastReadEventSeq = Number.isInteger(value.lastReadEventSeq) && (value.lastReadEventSeq as number) >= 0
    ? (value.lastReadEventSeq as number)
    : 0;
  const lastReadEventSeq = Math.min(parsedLastReadEventSeq, lastEventSeq);
  const filteredUnread = unread.filter((entry) => entry.seq > lastReadEventSeq && entry.seq <= lastEventSeq);

  return {
    lastEventSeq,
    lastReadEventSeq,
    unread: filteredUnread,
    updatedAt: typeof value.updatedAt === "string" && value.updatedAt ? value.updatedAt : nowIso()
  };
}

function unreadEntryKey(entry: Pick<StoredUnreadEntry, "kind" | "turnId" | "runId">) {
  return `${entry.kind}:${entry.turnId}:${entry.runId ?? ""}`;
}

function pendingTurnKey(sessionId: string, turnId: string) {
  return `${sessionId}:${turnId}`;
}

export class SessionUnreadService {
  private readonly stateBySession = new Map<string, StoredSessionUnreadState>();
  private readonly pendingCompletionByTurn = new Map<string, PendingCompletion>();

  constructor(private readonly filePath: string) {
    for (const [sessionId, state] of Object.entries(this.readState().sessions)) {
      this.stateBySession.set(sessionId, state);
    }
  }

  presentSessionSummary(session: SessionSummary) {
    const state = this.stateBySession.get(session.id);
    const unreadCount = state?.unread.length ?? 0;
    const lastEventSeq = state?.lastEventSeq ?? 0;
    const lastReadEventSeq = state?.lastReadEventSeq ?? 0;
    const hasUnreadCompletion = state?.unread.some((entry) => entry.kind === "completion") ?? false;
    const hasUnreadError = state?.unread.some((entry) => entry.kind === "error") ?? false;

    if (
      session.unreadCount === unreadCount
      && session.lastEventSeq === lastEventSeq
      && session.lastReadEventSeq === lastReadEventSeq
      && session.hasUnreadCompletion === hasUnreadCompletion
      && session.hasUnreadError === hasUnreadError
    ) {
      return session;
    }

    return {
      ...session,
      unreadCount,
      lastEventSeq,
      lastReadEventSeq,
      hasUnreadCompletion,
      hasUnreadError
    } satisfies SessionSummary;
  }

  presentSessionSummaries(sessions: SessionSummary[]) {
    return sessions.map((session) => this.presentSessionSummary(session));
  }

  presentSessionDetail(detail: SessionDetail) {
    const session = this.presentSessionSummary(detail.session);
    if (session === detail.session) {
      return detail;
    }

    return {
      ...detail,
      session
    };
  }

  stageCompletion(params: { sessionId: string; runId: string; turnId: string; createdAt?: string }) {
    if (!params.sessionId || !params.runId || !params.turnId) {
      return;
    }

    const key = pendingTurnKey(params.sessionId, params.turnId);
    if (this.pendingCompletionByTurn.has(key)) {
      return;
    }

    this.pendingCompletionByTurn.set(key, {
      sessionId: params.sessionId,
      runId: params.runId,
      turnId: params.turnId,
      createdAt: params.createdAt ?? nowIso()
    });
  }

  recordCompletion(sessionId: string, runId: string, turnId: string) {
    const key = pendingTurnKey(sessionId, turnId);
    const pending = this.pendingCompletionByTurn.get(key);
    this.pendingCompletionByTurn.delete(key);

    if (!pending || pending.runId !== runId) {
      return false;
    }

    return this.appendUnread(sessionId, {
      kind: "completion",
      turnId,
      runId,
      createdAt: pending.createdAt
    });
  }

  recordError(sessionId: string, runId: string, turnId: string, createdAt = nowIso()) {
    this.pendingCompletionByTurn.delete(pendingTurnKey(sessionId, turnId));

    return this.appendUnread(sessionId, {
      kind: "error",
      turnId,
      runId,
      createdAt
    });
  }

  clearPendingTurn(sessionId: string, turnId: string) {
    this.pendingCompletionByTurn.delete(pendingTurnKey(sessionId, turnId));
  }

  markRead(sessionId: string) {
    const current = this.stateBySession.get(sessionId);
    if (!current) {
      return false;
    }

    if (current.unread.length === 0 && current.lastReadEventSeq === current.lastEventSeq) {
      return false;
    }

    const next: StoredSessionUnreadState = {
      ...current,
      lastReadEventSeq: current.lastEventSeq,
      unread: [],
      updatedAt: nowIso()
    };
    this.stateBySession.set(sessionId, next);
    this.persistState();
    return true;
  }

  private appendUnread(
    sessionId: string,
    unread: Omit<StoredUnreadEntry, "seq">
  ) {
    const current = this.stateBySession.get(sessionId) ?? {
      lastEventSeq: 0,
      lastReadEventSeq: 0,
      unread: [],
      updatedAt: unread.createdAt
    } satisfies StoredSessionUnreadState;

    const nextKey = unreadEntryKey(unread);
    if (current.unread.some((entry) => unreadEntryKey(entry) === nextKey)) {
      return false;
    }

    const nextSeq = current.lastEventSeq + 1;
    const next: StoredSessionUnreadState = {
      lastEventSeq: nextSeq,
      lastReadEventSeq: current.lastReadEventSeq,
      unread: [
        ...current.unread,
        {
          seq: nextSeq,
          ...unread
        }
      ],
      updatedAt: nowIso()
    };

    this.stateBySession.set(sessionId, next);
    this.persistState();
    return true;
  }

  private readState(): StoredUnreadStateFile {
    if (!fs.existsSync(this.filePath)) {
      return {
        version: 1,
        sessions: {}
      };
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!isRecord(parsed) || !isRecord(parsed.sessions)) {
        return {
          version: 1,
          sessions: {}
        };
      }

      const sessions: Record<string, StoredSessionUnreadState> = {};
      for (const [sessionId, value] of Object.entries(parsed.sessions)) {
        if (!sessionId) {
          continue;
        }
        const normalized = normalizeSessionState(value);
        if (normalized) {
          sessions[sessionId] = normalized;
        }
      }

      return {
        version: 1,
        sessions
      };
    } catch {
      return {
        version: 1,
        sessions: {}
      };
    }
  }

  private persistState() {
    const state: StoredUnreadStateFile = {
      version: 1,
      sessions: Object.fromEntries(this.stateBySession.entries())
    };

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }
}
