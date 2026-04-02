import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import type {
  CreateRunRequest,
  LiveActivity,
  Message,
  Run,
  SessionDetail,
  SessionStatusConfidence,
  SessionStatusReasonCode,
  SessionSummary
} from "@codex-remote/shared-types";
import type { AppConfig } from "../config/env";
import type { CodexBackend, CodexBridgeEvent } from "../codex/types";
import { LiveCatalogService } from "../catalog/live-catalog-service";
import { PushNotificationService } from "../notifications/push-notification-service";
import { RealtimeGateway } from "../realtime/realtime-gateway";
import { SessionUnreadService } from "../sessions/session-unread-service";
import { ImageUploadService } from "../uploads/image-upload-service";
import type { CodexDebugLog } from "../observability/codex-debug-log";
import { resolveEffectiveCodexRunSettings, SessionRunSettingsStore } from "./session-run-settings-store";
import { nowIso } from "../utils/time";

function isRunInProgress(status: Run["status"]) {
  return status === "queued" || status === "running";
}

function isTerminalRunStatus(status: Run["status"]): status is Extract<Run["status"], "completed" | "interrupted" | "error"> {
  return status === "completed" || status === "interrupted" || status === "error";
}

type PresentedSessionState = {
  status: SessionSummary["status"];
  reasonCode: SessionStatusReasonCode | undefined;
  confidence: SessionStatusConfidence | undefined;
};

type PresentedRuns = {
  activeRun: Run | null;
  latestRun: Run | null;
  localState: "none" | "active" | "latest";
};

type SessionStatusSnapshot = {
  status: SessionSummary["status"];
  reasonCode: SessionStatusReasonCode | null;
  confidence: SessionStatusConfidence | null;
  latestTurnStatus: SessionSummary["latestTurnStatus"] | null;
  threadStatusType: SessionSummary["threadStatusType"] | null;
  activeRunStatus: Run["status"] | null;
  latestRunStatus: Run["status"] | null;
};

export class RunService {
  private readonly runsById = new Map<string, Run>();
  private readonly activeRunBySession = new Map<string, string>();
  private readonly latestRunBySession = new Map<string, string>();
  private readonly lastPresentedSnapshotBySession = new Map<string, SessionStatusSnapshot>();

  constructor(
    private readonly config: AppConfig,
    private readonly catalog: LiveCatalogService,
    private readonly realtime: RealtimeGateway,
    private readonly codex: CodexBackend,
    private readonly uploads: ImageUploadService,
    private readonly pushNotifications: PushNotificationService,
    private readonly sessionUnread: SessionUnreadService,
    private readonly logger: FastifyBaseLogger,
    private readonly debugLog?: CodexDebugLog,
    private readonly sessionRunSettings = new SessionRunSettingsStore(`${config.dataDir}/run-settings.json`)
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
    const effectiveRunSettings = resolveEffectiveCodexRunSettings(params.codex);
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
      threadId,
      codex: effectiveRunSettings
    });
    const effectiveSessionId = started.threadId;
    this.sessionRunSettings.set(effectiveSessionId, effectiveRunSettings);

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
    return this.presentSessionSummaryWithRuns(session, this.presentedRuns(session, this.summaryFallbackRuns(session)));
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
    const runs = this.presentedRuns(detail.session, {
      activeRun: detail.activeRun,
      latestRun: detail.latestRun
    });
    const session = this.presentSessionSummaryWithRuns(detail.session, runs);
    // Only bridge-owned run settings are treated as authoritative here. In local codex-cli 0.116.0
    // probes, `thread/resume` after a completed turn collapsed many distinct configurations back to
    // the same default-ish values (`on-request` / `read-only` / `gpt-5.4` / `serviceTier: null`),
    // so we intentionally avoid hydrating UI state from passive Codex thread inspection for now.
    const runSettings = this.sessionRunSettings.get(session.id);
    if (
      session === detail.session &&
      sameRun(detail.activeRun, runs.activeRun) &&
      sameRun(detail.latestRun, runs.latestRun) &&
      sameRunSettings(detail.runSettings, runSettings)
    ) {
      return detail;
    }

    return {
      ...detail,
      session,
      activeRun: runs.activeRun,
      latestRun: runs.latestRun,
      runSettings
    };
  }

  private presentSessionSummaryWithRuns(session: SessionSummary, runs: PresentedRuns) {
    if (runs.localState === "none") {
      this.logPresentedSessionSummary(session, runs);
      return session;
    }

    const presentedState = this.presentedSessionState(session, runs);
    const lastUserMessageAt = runs.latestRun?.startedAt ?? session.lastUserMessageAt;
    const lastRunFinishedAt =
      runs.activeRun || (runs.latestRun && isRunInProgress(runs.latestRun.status))
        ? undefined
        : runs.latestRun?.finishedAt ?? session.lastRunFinishedAt;

    if (
      presentedState.status === session.status &&
      presentedState.reasonCode === session.statusReasonCode &&
      presentedState.confidence === session.statusConfidence &&
      lastUserMessageAt === session.lastUserMessageAt &&
      lastRunFinishedAt === session.lastRunFinishedAt
    ) {
      this.logPresentedSessionSummary(session, runs);
      return session;
    }

    const presentedSession = {
      ...session,
      status: presentedState.status,
      statusReasonCode: presentedState.reasonCode,
      statusConfidence: presentedState.confidence,
      lastUserMessageAt,
      lastRunFinishedAt
    };

    this.logPresentedSessionSummary(presentedSession, runs);
    return presentedSession;
  }

  private presentedRuns(
    session: Pick<SessionSummary, "id" | "latestTurnId" | "latestTurnStatus" | "threadStatusType" | "updatedAt" | "createdAt" | "lastUserMessageAt" | "lastRunFinishedAt">,
    fallback: { activeRun: Run | null; latestRun: Run | null }
  ): PresentedRuns {
    const localRuns = this.getSessionRuns(session.id, {
      activeRun: null,
      latestRun: null
    });
    const localActiveRun = localRuns.activeRun;
    const localLatestRun = localRuns.latestRun;

    if (localActiveRun) {
      return {
        activeRun: localActiveRun,
        latestRun: localLatestRun ?? localActiveRun,
        localState: "active"
      };
    }

    if (localLatestRun) {
      if (isRunInProgress(localLatestRun.status)) {
        return {
          activeRun: localLatestRun,
          latestRun: localLatestRun,
          localState: "latest"
        };
      }

      if (this.matchesLatestTurn(session, fallback.latestRun, localLatestRun)) {
        return {
          activeRun: null,
          latestRun: localLatestRun,
          localState: "latest"
        };
      }
    }

    return {
      activeRun: fallback.activeRun,
      latestRun: fallback.latestRun,
      localState: "none"
    };
  }

  private summaryFallbackRuns(
    session: Pick<SessionSummary, "id" | "latestTurnId" | "latestTurnStatus" | "threadStatusType" | "updatedAt" | "createdAt" | "lastUserMessageAt" | "lastRunFinishedAt">
  ) {
    const status = this.summaryLatestRunStatus(session);
    if (!status || !session.latestTurnId) {
      return {
        activeRun: null,
        latestRun: null
      };
    }

    const run: Run = {
      id: session.latestTurnId,
      sessionId: session.id,
      turnId: session.latestTurnId,
      status,
      startedAt: session.lastUserMessageAt ?? session.updatedAt ?? session.createdAt,
      finishedAt: isRunInProgress(status) ? undefined : session.lastRunFinishedAt ?? session.updatedAt
    };

    return {
      activeRun: isRunInProgress(run.status) ? run : null,
      latestRun: run
    };
  }

  private summaryLatestRunStatus(
    session: Pick<SessionSummary, "latestTurnStatus" | "threadStatusType">
  ): Run["status"] | null {
    switch (session.latestTurnStatus) {
      case "completed":
        return "completed";
      case "interrupted":
        return "interrupted";
      case "failed":
        return "error";
      case "inProgress":
        return session.threadStatusType === "active" ? "running" : "interrupted";
      default:
        return null;
    }
  }

  private matchesLatestTurn(
    session: Pick<SessionSummary, "latestTurnId">,
    fallbackLatestRun: Run | null,
    run: Pick<Run, "id" | "turnId">
  ) {
    const latestTurnId = session.latestTurnId ?? fallbackLatestRun?.turnId ?? fallbackLatestRun?.id;
    if (!latestTurnId) {
      return false;
    }

    return run.turnId === latestTurnId || run.id === latestTurnId;
  }

  private presentedSessionState(
    session: Pick<SessionSummary, "status" | "statusReasonCode" | "statusConfidence">,
    runs: Pick<PresentedRuns, "activeRun" | "latestRun" | "localState">
  ): PresentedSessionState {
    if (runs.localState === "active" && runs.activeRun) {
      return {
        status: "running",
        reasonCode: "local_active_run",
        confidence: "authoritative"
      };
    }

    switch (runs.localState === "latest" ? runs.latestRun?.status : undefined) {
      case "queued":
        return {
          status: "running",
          reasonCode: "local_latest_run_queued",
          confidence: "authoritative"
        };
      case "running":
        return {
          status: "running",
          reasonCode: "local_latest_run_running",
          confidence: "authoritative"
        };
      case "completed":
        return {
          status: "completed",
          reasonCode: "local_latest_run_completed",
          confidence: "authoritative"
        };
      case "interrupted":
        return {
          status: "interrupted",
          reasonCode: "local_latest_run_interrupted",
          confidence: "authoritative"
        };
      case "error":
        return {
          status: "error",
          reasonCode: "local_latest_run_error",
          confidence: "authoritative"
        };
      default:
        return {
          status: session.status,
          reasonCode: session.statusReasonCode,
          confidence: session.statusConfidence
        };
    }
  }

  private logPresentedSessionSummary(
    session: SessionSummary,
    runs: Pick<PresentedRuns, "activeRun" | "latestRun">
  ) {
    if (!this.debugLog) {
      return;
    }

    const nextSnapshot: SessionStatusSnapshot = {
      status: session.status,
      reasonCode: session.statusReasonCode ?? null,
      confidence: session.statusConfidence ?? null,
      latestTurnStatus: session.latestTurnStatus ?? null,
      threadStatusType: session.threadStatusType ?? null,
      activeRunStatus: runs.activeRun?.status ?? null,
      latestRunStatus: runs.latestRun?.status ?? null
    };
    const previousSnapshot = this.lastPresentedSnapshotBySession.get(session.id);
    if (previousSnapshot && this.sameSnapshot(previousSnapshot, nextSnapshot)) {
      return;
    }

    this.debugLog.write("session.status.derived", {
      sessionId: session.id,
      previousStatus: previousSnapshot?.status ?? null,
      status: nextSnapshot.status,
      previousReasonCode: previousSnapshot?.reasonCode ?? null,
      statusReasonCode: nextSnapshot.reasonCode,
      previousConfidence: previousSnapshot?.confidence ?? null,
      statusConfidence: nextSnapshot.confidence,
      latestTurnStatus: nextSnapshot.latestTurnStatus,
      threadStatusType: nextSnapshot.threadStatusType,
      activeRunStatus: nextSnapshot.activeRunStatus,
      latestRunStatus: nextSnapshot.latestRunStatus
    });

    if (nextSnapshot.confidence === "suspicious") {
      this.debugLog.write("session.status.suspected_misclassification", {
        sessionId: session.id,
        status: nextSnapshot.status,
        statusReasonCode: nextSnapshot.reasonCode,
        latestTurnStatus: nextSnapshot.latestTurnStatus,
        threadStatusType: nextSnapshot.threadStatusType,
        activeRunStatus: nextSnapshot.activeRunStatus,
        latestRunStatus: nextSnapshot.latestRunStatus
      });
    }

    this.lastPresentedSnapshotBySession.set(session.id, nextSnapshot);
  }

  private sameSnapshot(left: SessionStatusSnapshot, right: SessionStatusSnapshot) {
    return left.status === right.status
      && left.reasonCode === right.reasonCode
      && left.confidence === right.confidence
      && left.latestTurnStatus === right.latestTurnStatus
      && left.threadStatusType === right.threadStatusType
      && left.activeRunStatus === right.activeRunStatus
      && left.latestRunStatus === right.latestRunStatus;
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
      if (event.countsUnread) {
        this.sessionUnread.stageCompletion({
          sessionId: event.sessionId,
          runId: event.runId,
          turnId: event.turnId,
          createdAt: message.createdAt
        });
      }
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

    if (event.type === "request.created") {
      this.realtime.broadcastCodexRequestCreated(event.sessionId, event.request);
      try {
        const detail = await this.catalog.getSessionDetail(event.sessionId);
        await this.pushNotifications.notifyPendingRequest(this.presentSessionDetail(detail), event.request);
      } catch (error) {
        this.logger.warn(
          {
            err: error,
            requestId: event.request.id,
            sessionId: event.sessionId
          },
          "Unable to send push notification for pending request"
        );
      }
      return;
    }

    if (event.type === "request.resolved") {
      this.realtime.broadcastCodexRequestResolved(event.sessionId, event.requestId);
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
    const shouldNotifyTerminalTransition = isRunInProgress(current.status) && isTerminalRunStatus(next.status);

    if (event.type === "run.completed") {
      this.sessionUnread.recordCompletion(event.sessionId, event.runId, event.turnId);
    } else if (event.type === "run.error") {
      this.sessionUnread.recordError(event.sessionId, event.runId, event.turnId, finishedAt);
    } else {
      this.sessionUnread.clearPendingTurn(event.sessionId, event.turnId);
    }

    this.runsById.set(event.runId, next);
    this.activeRunBySession.delete(event.sessionId);
    this.latestRunBySession.set(event.sessionId, event.runId);
    this.realtime.broadcastRun(event.type, next);

    if (shouldNotifyTerminalTransition) {
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

function sameRunSettings(left: SessionDetail["runSettings"], right: SessionDetail["runSettings"]) {
  return left?.approvalPolicy === right?.approvalPolicy
    && left?.sandbox === right?.sandbox
    && left?.serviceTier === right?.serviceTier
    && left?.model === right?.model;
}

function sameRun(left: Run | null, right: Run | null) {
  return left?.id === right?.id
    && left?.sessionId === right?.sessionId
    && left?.turnId === right?.turnId
    && left?.status === right?.status
    && left?.startedAt === right?.startedAt
    && left?.finishedAt === right?.finishedAt
    && left?.errorMessage === right?.errorMessage;
}
