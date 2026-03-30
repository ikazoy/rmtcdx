import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import type {
  Message,
  Repository,
  Run,
  RunStatus,
  SessionDetail,
  SessionFilter,
  SessionStatus,
  SessionSummary
} from "@codex-remote/shared-types";
import type { RepoConfig } from "../config/repos";
import { excerpt } from "../utils/text";
import { nowIso } from "../utils/time";

type SessionRow = {
  id: string;
  repo_id: string;
  title: string;
  summary: string;
  codex_thread_id: string | null;
  status: SessionStatus;
  unread_count: number;
  last_event_seq: number;
  last_read_event_seq: number;
  last_message_at: string;
  last_run_finished_at: string | null;
  latest_user_prompt: string | null;
  latest_assistant_excerpt: string | null;
  created_at: string;
  updated_at: string;
};

type RepositoryRow = {
  id: string;
  name: string;
  path: string;
  description: string | null;
  pinned: number;
  created_at: string;
  updated_at: string;
};

type RunRow = {
  id: string;
  session_id: string;
  turn_id: string | null;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
};

type MessageRow = {
  id: string;
  session_id: string;
  role: Message["role"];
  text: string;
  created_at: string;
};

export class Database {
  readonly sqlite: BetterSqlite3.Database;

  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.sqlite = new BetterSqlite3(filePath);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
  }

  init() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        description TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        codex_thread_id TEXT,
        status TEXT NOT NULL,
        unread_count INTEGER NOT NULL DEFAULT 0,
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        last_read_event_seq INTEGER NOT NULL DEFAULT 0,
        last_message_at TEXT NOT NULL,
        last_run_finished_at TEXT,
        latest_user_prompt TEXT,
        latest_assistant_excerpt TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS event_logs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_repo_updated ON sessions(repo_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_runs_session_started ON runs(session_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_turn ON runs(turn_id);
      CREATE INDEX IF NOT EXISTS idx_event_logs_session_seq ON event_logs(session_id, seq DESC);
    `);
  }

  syncRepositories(repos: RepoConfig[]) {
    const upsert = this.sqlite.prepare(`
      INSERT INTO repositories (id, name, path, description, pinned, created_at, updated_at)
      VALUES (@id, @name, @path, @description, @pinned, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        path = excluded.path,
        description = excluded.description,
        pinned = excluded.pinned,
        updated_at = excluded.updated_at
    `);

    const existingIds = new Set(
      this.sqlite.prepare("SELECT id FROM repositories").all().map((row) => String((row as { id: string }).id))
    );

    const now = nowIso();
    const transaction = this.sqlite.transaction(() => {
      for (const repo of repos) {
        existingIds.delete(repo.id);
        upsert.run({
          id: repo.id,
          name: repo.name,
          path: repo.path,
          description: repo.description ?? null,
          pinned: repo.pinned ? 1 : 0,
          createdAt: now,
          updatedAt: now
        });
      }

      for (const removedId of existingIds) {
        this.sqlite.prepare("DELETE FROM repositories WHERE id = ?").run(removedId);
      }
    });

    transaction();
  }

  listRepositoriesBase() {
    const rows = this.sqlite
      .prepare<[], RepositoryRow>("SELECT * FROM repositories ORDER BY pinned DESC, updated_at DESC, name ASC")
      .all();

    return rows.map((row) => this.mapRepository(row));
  }

  getRepository(repoId: string) {
    const row = this.sqlite.prepare<[string], RepositoryRow>("SELECT * FROM repositories WHERE id = ?").get(repoId);
    return row ? this.mapRepository(row) : null;
  }

  countRunningSessions(repoId: string) {
    const row = this.sqlite
      .prepare<[string], { count: number }>(
        "SELECT COUNT(*) AS count FROM sessions WHERE repo_id = ? AND status = 'running'"
      )
      .get(repoId);

    return row?.count ?? 0;
  }

  createSession(repoId: string, title: string) {
    const now = nowIso();
    const sessionId = `sess_${randomUUID()}`;
    this.sqlite
      .prepare(
        `
          INSERT INTO sessions (
            id, repo_id, title, summary, codex_thread_id, status, unread_count,
            last_event_seq, last_read_event_seq, last_message_at, last_run_finished_at,
            latest_user_prompt, latest_assistant_excerpt, created_at, updated_at
          ) VALUES (?, ?, ?, ?, NULL, 'idle', 0, 0, 0, ?, NULL, NULL, NULL, ?, ?)
        `
      )
      .run(sessionId, repoId, title, "Ready to run", now, now, now);

    return this.getSession(sessionId)!;
  }

  listSessions(repoId: string, options?: { search?: string; filter?: SessionFilter }) {
    const clauses = ["repo_id = ?"];
    const params: Array<string | number> = [repoId];

    const search = options?.search?.trim();
    if (search) {
      clauses.push(
        "(title LIKE ? OR summary LIKE ? OR COALESCE(latest_user_prompt, '') LIKE ? OR COALESCE(latest_assistant_excerpt, '') LIKE ?)"
      );
      const term = `%${search}%`;
      params.push(term, term, term, term);
    }

    if (options?.filter && options.filter !== "all") {
      if (options.filter === "running") {
        clauses.push("status = 'running'");
      } else if (options.filter === "unread") {
        clauses.push("unread_count > 0");
      } else if (options.filter === "completed") {
        clauses.push("status = 'completed'");
      } else if (options.filter === "error") {
        clauses.push("status = 'error'");
      } else if (options.filter === "archived") {
        clauses.push("status = 'archived'");
      }
    } else {
      clauses.push("status != 'archived'");
    }

    const sql = `
      SELECT * FROM sessions
      WHERE ${clauses.join(" AND ")}
      ORDER BY
        CASE
          WHEN status = 'running' THEN 0
          WHEN unread_count > 0 AND status IN ('completed', 'error') THEN 1
          ELSE 2
        END ASC,
        updated_at DESC
    `;

    const rows = this.sqlite.prepare(sql).all(...params) as SessionRow[];
    return rows.map((row) => this.mapSession(row));
  }

  getSession(sessionId: string) {
    const row = this.sqlite.prepare<[string], SessionRow>("SELECT * FROM sessions WHERE id = ?").get(sessionId);
    return row ? this.mapSession(row) : null;
  }

  getSessionDetail(sessionId: string): SessionDetail | null {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }

    return {
      session,
      activeRun: this.getActiveRunBySession(sessionId),
      latestRun: this.getLatestRun(sessionId)
    };
  }

  setSessionThread(sessionId: string, threadId: string) {
    this.sqlite
      .prepare("UPDATE sessions SET codex_thread_id = ?, updated_at = ? WHERE id = ?")
      .run(threadId, nowIso(), sessionId);
  }

  markSessionRead(sessionId: string) {
    this.sqlite
      .prepare(
        `
          UPDATE sessions
          SET last_read_event_seq = last_event_seq,
              unread_count = 0,
              updated_at = ?
          WHERE id = ?
        `
      )
      .run(nowIso(), sessionId);
  }

  archiveSession(sessionId: string) {
    const now = nowIso();
    this.sqlite.prepare("UPDATE sessions SET status = 'archived', updated_at = ? WHERE id = ?").run(now, sessionId);
  }

  appendUserMessage(sessionId: string, text: string, nextTitle?: string) {
    const now = nowIso();
    const message = this.insertMessage(sessionId, "user", text, now);
    this.sqlite
      .prepare(
        `
          UPDATE sessions
          SET title = COALESCE(?, title),
              latest_user_prompt = ?,
              last_message_at = ?,
              updated_at = ?
          WHERE id = ?
        `
      )
      .run(nextTitle ?? null, excerpt(text, 220), now, now, sessionId);

    return message;
  }

  appendAssistantMessage(
    sessionId: string,
    text: string,
    options?: {
      countsUnread?: boolean;
      status?: SessionStatus;
    }
  ) {
    const now = nowIso();
    const message = this.insertMessage(sessionId, "assistant", text, now);
    this.sqlite
      .prepare(
        `
          UPDATE sessions
          SET summary = ?,
              latest_assistant_excerpt = ?,
              last_message_at = ?,
              updated_at = ?,
              status = COALESCE(?, status)
          WHERE id = ?
        `
      )
      .run(excerpt(text, 120), excerpt(text, 220), now, now, options?.status ?? null, sessionId);

    if (options?.countsUnread) {
      this.recordEvent(sessionId, "assistant.final", { text }, true);
    }

    return message;
  }

  listMessages(sessionId: string) {
    const rows = this.sqlite
      .prepare<[string], MessageRow>("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId);

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      kind: row.role === "user" ? "user_message" : row.role === "assistant" ? "assistant_message" : "context_compaction",
      text: row.text,
      createdAt: row.created_at
    }));
  }

  createRun(sessionId: string) {
    const runId = `run_${randomUUID()}`;
    const now = nowIso();
    this.sqlite
      .prepare(
        `
          INSERT INTO runs (id, session_id, turn_id, status, started_at, finished_at, error_message)
          VALUES (?, ?, NULL, 'running', ?, NULL, NULL)
        `
      )
      .run(runId, sessionId, now);

    this.sqlite
      .prepare("UPDATE sessions SET status = 'running', updated_at = ? WHERE id = ?")
      .run(now, sessionId);

    return this.getRun(runId)!;
  }

  attachRunTurn(runId: string, turnId: string) {
    this.sqlite.prepare("UPDATE runs SET turn_id = ? WHERE id = ?").run(turnId, runId);
  }

  updateRunStatus(runId: string, status: RunStatus, errorMessage?: string) {
    const isTerminal = status !== "running" && status !== "queued";
    const finishedAt = isTerminal ? nowIso() : null;
    this.sqlite
      .prepare(
        `
          UPDATE runs
          SET status = ?, finished_at = COALESCE(?, finished_at), error_message = COALESCE(?, error_message)
          WHERE id = ?
        `
      )
      .run(status, finishedAt, errorMessage ?? null, runId);

    return this.getRun(runId)!;
  }

  getRun(runId: string) {
    const row = this.sqlite.prepare<[string], RunRow>("SELECT * FROM runs WHERE id = ?").get(runId);
    return row ? this.mapRun(row) : null;
  }

  getRunByTurnId(turnId: string) {
    const row = this.sqlite.prepare<[string], RunRow>("SELECT * FROM runs WHERE turn_id = ?").get(turnId);
    return row ? this.mapRun(row) : null;
  }

  getActiveRunBySession(sessionId: string) {
    const row = this.sqlite
      .prepare<[string], RunRow>(
        "SELECT * FROM runs WHERE session_id = ? AND status IN ('queued', 'running') ORDER BY started_at DESC LIMIT 1"
      )
      .get(sessionId);

    return row ? this.mapRun(row) : null;
  }

  getLatestRun(sessionId: string) {
    const row = this.sqlite
      .prepare<[string], RunRow>("SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(sessionId);

    return row ? this.mapRun(row) : null;
  }

  getActiveRunsCount() {
    const row = this.sqlite
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM runs WHERE status IN ('queued', 'running')")
      .get();

    return row?.count ?? 0;
  }

  recordEvent(sessionId: string, kind: string, payload: unknown, countsUnread: boolean) {
    const session = this.getSession(sessionId);
    if (!session) {
      return 0;
    }

    const now = nowIso();
    const info = this.sqlite
      .prepare("INSERT INTO event_logs (session_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)")
      .run(sessionId, kind, JSON.stringify(payload), now);
    const seq = Number(info.lastInsertRowid);
    const unreadCount = countsUnread ? Math.max(0, seq - session.lastReadEventSeq) : session.unreadCount;

    this.sqlite
      .prepare(
        `
          UPDATE sessions
          SET last_event_seq = ?, unread_count = ?, updated_at = ?
          WHERE id = ?
        `
      )
      .run(seq, unreadCount, now, sessionId);

    return seq;
  }

  updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
    options?: {
      lastRunFinishedAt?: string;
    }
  ) {
    this.sqlite
      .prepare(
        `
          UPDATE sessions
          SET status = ?,
              last_run_finished_at = COALESCE(?, last_run_finished_at),
              updated_at = ?
          WHERE id = ?
        `
      )
      .run(status, options?.lastRunFinishedAt ?? null, nowIso(), sessionId);
  }

  getDbOk() {
    try {
      this.sqlite.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  private insertMessage(sessionId: string, role: Message["role"], text: string, createdAt: string): Message {
    const id = `msg_${randomUUID()}`;
    this.sqlite
      .prepare("INSERT INTO messages (id, session_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, sessionId, role, text, createdAt);

    return {
      id,
      sessionId,
      role,
      kind: role === "user" ? "user_message" : role === "assistant" ? "assistant_message" : "context_compaction",
      text,
      createdAt
    };
  }

  private mapRepository(row: RepositoryRow): Repository {
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      description: row.description ?? undefined,
      pinned: Boolean(row.pinned),
      runningSessionCount: this.countRunningSessions(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapSession(row: SessionRow): SessionSummary {
    const hasUnreadCompletion = row.unread_count > 0 && row.status === "completed";
    const hasUnreadError = row.unread_count > 0 && row.status === "error";

    return {
      id: row.id,
      repoId: row.repo_id,
      title: row.title,
      summary: row.summary,
      codexThreadId: row.codex_thread_id ?? undefined,
      status: row.status,
      isArchived: row.status === "archived",
      unreadCount: row.unread_count,
      lastEventSeq: row.last_event_seq,
      lastReadEventSeq: row.last_read_event_seq,
      lastMessageAt: row.last_message_at,
      lastRunFinishedAt: row.last_run_finished_at ?? undefined,
      latestUserPrompt: row.latest_user_prompt ?? undefined,
      latestAssistantExcerpt: row.latest_assistant_excerpt ?? undefined,
      hasUnreadCompletion,
      hasUnreadError,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapRun(row: RunRow): Run {
    return {
      id: row.id,
      sessionId: row.session_id,
      turnId: row.turn_id ?? undefined,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      errorMessage: row.error_message ?? undefined
    };
  }
}
