import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import type {
  CreateRunRequest,
  LiveActivity,
  Message,
  Run,
  SessionDetail,
  SessionSummary
} from "@codex-remote/shared-types";
import type { AppConfig } from "../config/env";
import type { CodexBackend, CodexBridgeEvent } from "../codex/types";
import { LiveCatalogService } from "../catalog/live-catalog-service";
import { PushNotificationService } from "../notifications/push-notification-service";
import { RealtimeGateway } from "../realtime/realtime-gateway";
import { ImageUploadService } from "../uploads/image-upload-service";
import { nowIso } from "../utils/time";

export class RunService {
  private readonly runsById = new Map<string, Run>();
  private readonly activeRunBySession = new Map<string, string>();
  private readonly latestRunBySession = new Map<string, string>();

  constructor(
    private readonly config: AppConfig,
    private readonly catalog: LiveCatalogService,
    private readonly realtime: RealtimeGateway,
    private readonly codex: CodexBackend,
    private readonly uploads: ImageUploadService,
    private readonly pushNotifications: PushNotificationService,
    private readonly logger: FastifyBaseLogger
  ) {
    this.codex.on("event", (event: CodexBridgeEvent) => {
      void this.handleBackendEvent(event);
    });
  }

  async start(params: CreateRunRequest) {
    const sessionId = params.sessionId;
    const repoId = params.repoId;
    const prompt = params.prompt;
    const attachments = params.attachments ?? [];

    if (!prompt.trim() && attachments.length === 0) {
      throw new Error("Prompt or image attachment is required.");
    }
    if (prompt.length > this.config.maxPromptLength) {
      throw new Error(`Prompt is too long. Max ${this.config.maxPromptLength} characters.`);
    }
    if (sessionId && this.activeRunBySession.has(sessionId)) {
      throw new Error("This session already has an active run.");
    }

    const runId = `run_${randomUUID()}`;
    const startedAt = nowIso();
    let cwd: string;
    let threadId: string | undefined;

    if (sessionId) {
      const detail = await this.catalog.getSessionDetail(sessionId);
      if (!detail) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      if (detail.session.isArchived) {
        throw new Error("Restore this thread before starting a run.");
      }
      const thread = await this.catalog.getThread(sessionId);
      cwd = thread.cwd;
      threadId = thread.id;
    } else if (repoId) {
      const repo = await this.catalog.getRepo(repoId);
      if (!repo) {
        throw new Error(`Repository not found: ${repoId}`);
      }
      cwd = repo.path;
    } else {
      throw new Error("sessionId or repoId is required");
    }

    const storedAttachments = await this.uploads.stage(attachments);
    const started = await this.codex.startRun({
      sessionId,
      runId,
      cwd,
      input: [
        ...(prompt.trim() ? [{ type: "text" as const, text: prompt, text_elements: [] }] : []),
        ...storedAttachments.map((attachment) => ({ type: "localImage" as const, path: attachment.path }))
      ],
      threadId
    });
    const effectiveSessionId = started.threadId;

    const run: Run = {
      id: runId,
      sessionId: effectiveSessionId,
      turnId: started.turnId,
      status: "running",
      startedAt
    };

    this.runsById.set(runId, run);
    this.activeRunBySession.set(effectiveSessionId, runId);
    this.latestRunBySession.set(effectiveSessionId, runId);
    this.realtime.broadcastRun("run.started", run);
    return run;
  }

  async interrupt(runId: string) {
    const run = this.runsById.get(runId);
    if (!run?.turnId) {
      return null;
    }

    await this.codex.interruptRun(run.id, run.sessionId, run.turnId);
    return this.runsById.get(runId) ?? null;
  }

  get(runId: string) {
    return this.runsById.get(runId) ?? null;
  }

  getActiveRunsCount() {
    return this.activeRunBySession.size;
  }

  getSessionRuns(sessionId: string, fallback: { activeRun: Run | null; latestRun: Run | null }) {
    const activeRunId = this.activeRunBySession.get(sessionId);
    const latestRunId = this.latestRunBySession.get(sessionId);

    return {
      activeRun: activeRunId ? this.runsById.get(activeRunId) ?? fallback.activeRun : fallback.activeRun,
      latestRun: latestRunId ? this.runsById.get(latestRunId) ?? fallback.latestRun : fallback.latestRun
    };
  }

  presentSessionSummary(session: SessionSummary) {
    const lastUserMessageAt = this.latestRunBySession.get(session.id)
      ? this.runsById.get(this.latestRunBySession.get(session.id)!)?.startedAt ?? session.lastUserMessageAt
      : session.lastUserMessageAt;

    return lastUserMessageAt && lastUserMessageAt !== session.lastUserMessageAt
      ? {
          ...session,
          lastUserMessageAt
        }
      : session;
  }

  presentSessionSummaries(sessions: SessionSummary[]) {
    return [...sessions]
      .map((session) => this.presentSessionSummary(session))
      .sort((left, right) => {
        const primary = this.toTime(right.lastUserMessageAt ?? right.updatedAt ?? right.createdAt)
          - this.toTime(left.lastUserMessageAt ?? left.updatedAt ?? left.createdAt);
        if (primary !== 0) {
          return primary;
        }

        const secondary = this.toTime(right.updatedAt) - this.toTime(left.updatedAt);
        if (secondary !== 0) {
          return secondary;
        }

        return right.id.localeCompare(left.id);
      });
  }

  presentSessionDetail(detail: SessionDetail) {
    const session = this.presentSessionSummary(detail.session);
    return session === detail.session
      ? detail
      : {
          ...detail,
          session
        };
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
      const message: Message = {
        id: `${event.turnId}:final`,
        sessionId: event.sessionId,
        role: "assistant",
        kind: "assistant_message",
        text: event.text,
        createdAt: nowIso()
      };
      this.realtime.broadcastMessageFinal(event.sessionId, event.runId, message as Message & { role: "assistant" });
      return;
    }

    if (event.type === "activity.started") {
      const activity: LiveActivity = {
        sessionId: event.sessionId,
        runId: event.runId,
        turnId: event.turnId,
        itemId: event.itemId,
        kind: event.kind,
        label: event.label,
        output: "",
        startedAt: nowIso(),
        updatedAt: nowIso()
      };
      this.realtime.broadcastActivityStarted(activity);
      return;
    }

    if (event.type === "activity.updated") {
      this.realtime.broadcastActivityUpdated(event.sessionId, event.itemId, event.delta, nowIso());
      return;
    }

    if (event.type === "activity.completed") {
      this.realtime.broadcastActivityCompleted(event.sessionId, event.itemId);
      return;
    }

    if (event.type === "tool.start" || event.type === "tool.end") {
      return;
    }

    const current = this.runsById.get(event.runId);
    if (!current) {
      return;
    }

    const finishedAt = nowIso();
    const next: Run = {
      ...current,
      status:
        event.type === "run.completed"
          ? "completed"
          : event.type === "run.interrupted"
            ? "interrupted"
            : "error",
      finishedAt,
      errorMessage: event.type === "run.error" ? event.message : undefined
    };

    this.runsById.set(event.runId, next);
    this.activeRunBySession.delete(event.sessionId);
    this.latestRunBySession.set(event.sessionId, event.runId);
    this.realtime.broadcastRun(event.type, next);

    if (event.type === "run.completed" || event.type === "run.error") {
      try {
        const detail = await this.catalog.getSessionDetail(event.sessionId);
        await this.pushNotifications.notifyRun(this.presentSessionDetail(detail), next);
      } catch (error) {
        this.logger.warn(
          {
            err: error,
            runId: next.id,
            sessionId: next.sessionId
          },
          "Unable to send push notification for run event"
        );
      }
    }
  }

  private toTime(value: string) {
    const time = Date.parse(value);
    return Number.isNaN(time) ? 0 : time;
  }
}
