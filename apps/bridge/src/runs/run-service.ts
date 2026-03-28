import type { Message, Run } from "../../../../packages/shared-types/src/index";
import type { AppConfig } from "../config/env";
import type { CodexBackend, CodexBridgeEvent } from "../codex/types";
import { Database } from "../db/database";
import { RealtimeGateway } from "../realtime/realtime-gateway";
import { RepositoryService } from "../repos/repository-service";
import { SessionService } from "../sessions/session-service";
import { nowIso } from "../utils/time";

export class RunService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
    private readonly repositories: RepositoryService,
    private readonly sessions: SessionService,
    private readonly realtime: RealtimeGateway,
    private readonly codex: CodexBackend
  ) {
    this.codex.on("event", (event: CodexBridgeEvent) => {
      void this.handleBackendEvent(event);
    });
  }

  async start(sessionId: string, prompt: string) {
    if (!prompt.trim()) {
      throw new Error("Prompt must not be empty");
    }
    if (prompt.length > this.config.maxPromptLength) {
      throw new Error(`Prompt is too long. Max ${this.config.maxPromptLength} characters.`);
    }
    if (this.db.getActiveRunsCount() >= this.config.maxConcurrentRuns) {
      throw new Error("Another run is already active. Wait for it to finish first.");
    }

    const detail = this.sessions.detailOrThrow(sessionId);
    if (detail.activeRun) {
      throw new Error("This session already has an active run.");
    }

    const repo = await this.repositories.get(detail.session.repoId);
    if (!repo) {
      throw new Error(`Unknown repository for session ${sessionId}`);
    }

    this.sessions.onUserPrompt(detail.session, prompt);
    const run = this.db.createRun(sessionId);
    const started = await this.codex.startRun({
      sessionId,
      runId: run.id,
      cwd: repo.path,
      prompt,
      threadId: detail.session.codexThreadId
    });
    this.db.attachRunTurn(run.id, started.turnId);
    if (!detail.session.codexThreadId || detail.session.codexThreadId !== started.threadId) {
      this.sessions.updateThread(sessionId, started.threadId);
    }

    const refreshedRun = this.db.getRun(run.id)!;
    const refreshedDetail = this.sessions.detailOrThrow(sessionId);
    this.realtime.broadcastRun("run.started", refreshedRun);
    this.realtime.broadcastSession(refreshedDetail.session);
    this.realtime.broadcastSessionDetail(refreshedDetail);
    return refreshedRun;
  }

  async interrupt(runId: string) {
    const run = this.db.getRun(runId);
    if (!run || !run.turnId) {
      return null;
    }
    const sessionDetail = this.sessions.detailOrThrow(run.sessionId);
    const threadId = sessionDetail.session.codexThreadId;
    if (!threadId) {
      return null;
    }
    await this.codex.interruptRun(runId, threadId, run.turnId);
    return this.db.getRun(runId);
  }

  get(runId: string) {
    return this.db.getRun(runId);
  }

  private async handleBackendEvent(event: CodexBridgeEvent) {
    if (event.type === "backend.degraded") {
      this.realtime.broadcastBackendDegraded(event.reason);
      return;
    }

    if (event.type === "message.delta") {
      this.realtime.broadcastMessageDelta(event.sessionId, event.runId, event.text);
      return;
    }

    if (event.type === "message.final") {
      const session = this.sessions.detailOrThrow(event.sessionId).session;
      const message = this.sessions.onAssistantFinal(
        event.sessionId,
        event.text,
        event.countsUnread ? session.status === "error" ? "error" : "running" : session.status
      );
      this.realtime.broadcastMessageFinal(event.sessionId, event.runId, message as Message & { role: "assistant" });
      const detail = this.sessions.detailOrThrow(event.sessionId);
      this.realtime.broadcastSession(detail.session);
      this.realtime.broadcastSessionDetail(detail);
      return;
    }

    if (event.type === "tool.start" || event.type === "tool.end") {
      this.db.recordEvent(event.sessionId, event.type, { name: event.name }, false);
      const detail = this.sessions.detailOrThrow(event.sessionId);
      this.realtime.broadcastSession(detail.session);
      return;
    }

    const run = this.db.updateRunStatus(
      event.runId,
      event.type === "run.completed"
        ? "completed"
        : event.type === "run.interrupted"
          ? "interrupted"
          : "error",
      event.type === "run.error" ? event.message : undefined
    );
    const finishedAt = run.finishedAt ?? nowIso();
    if (event.type === "run.completed") {
      this.db.recordEvent(event.sessionId, "run.completed", { runId: run.id }, true);
      this.sessions.updateStatus(event.sessionId, "completed", finishedAt);
      this.realtime.broadcastRun("run.completed", run);
    } else if (event.type === "run.interrupted") {
      this.db.recordEvent(event.sessionId, "run.interrupted", { runId: run.id }, false);
      this.sessions.updateStatus(event.sessionId, "idle", finishedAt);
      this.realtime.broadcastRun("run.interrupted", run);
    } else {
      this.db.recordEvent(event.sessionId, "run.error", { runId: run.id, message: event.message }, true);
      this.sessions.updateStatus(event.sessionId, "error", finishedAt);
      this.realtime.broadcastRun("run.error", run);
    }

    const detail = this.sessions.detailOrThrow(event.sessionId);
    this.realtime.broadcastSession(detail.session);
    this.realtime.broadcastSessionDetail(detail);
  }
}
