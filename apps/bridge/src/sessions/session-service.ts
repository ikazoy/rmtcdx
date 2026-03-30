import type {
  SessionDetail,
  SessionFilter,
  SessionSummary
} from "@codex-remote/shared-types";
import { Database } from "../db/database";
import { deriveTitle } from "../utils/text";

export class SessionService {
  constructor(private readonly db: Database) {}

  list(repoId: string, options?: { search?: string; filter?: SessionFilter }) {
    return this.db.listSessions(repoId, options);
  }

  get(sessionId: string) {
    return this.db.getSessionDetail(sessionId);
  }

  create(repoId: string, title?: string) {
    const resolvedTitle = title?.trim() || "New session";
    return this.db.createSession(repoId, resolvedTitle);
  }

  markRead(sessionId: string) {
    this.db.markSessionRead(sessionId);
    return this.db.getSessionDetail(sessionId);
  }

  archive(sessionId: string) {
    this.db.archiveSession(sessionId);
    return this.db.getSessionDetail(sessionId);
  }

  listMessages(sessionId: string) {
    return this.db.listMessages(sessionId);
  }

  onUserPrompt(session: SessionSummary, prompt: string) {
    const shouldRename = session.title === "New session";
    return this.db.appendUserMessage(session.id, prompt, shouldRename ? deriveTitle(prompt) : undefined);
  }

  onAssistantFinal(sessionId: string, text: string, status: SessionSummary["status"]) {
    return this.db.appendAssistantMessage(sessionId, text, {
      countsUnread: true,
      status
    });
  }

  updateThread(sessionId: string, threadId: string) {
    this.db.setSessionThread(sessionId, threadId);
  }

  updateStatus(sessionId: string, status: SessionSummary["status"], lastRunFinishedAt?: string) {
    this.db.updateSessionStatus(sessionId, status, { lastRunFinishedAt });
  }

  detailOrThrow(sessionId: string): SessionDetail {
    const detail = this.db.getSessionDetail(sessionId);
    if (!detail) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    return detail;
  }
}
