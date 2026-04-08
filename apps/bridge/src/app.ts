import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";

import type {
  AccountRateLimitsResponse,
  ClientWsEvent,
  CodexModelsResponse,
  CodexPendingRequestResponse,
  CreateRunRequest,
  CreateSessionRequest,
  DeletePushSubscriptionRequest,
  NotificationsConfigResponse,
  PendingCodexRequestsResponse,
  SavePushSubscriptionRequest,
  SessionDetail,
  SessionFilePreviewRequest,
  SessionFilePreviewResponse,
  SessionFilter,
  SessionSummary,
  SimulateCodexRequestRequest,
  SimulateCodexRequestResponse
} from "@codex-remote/shared-types";
import { matchesSessionFilter } from "@codex-remote/shared-types";
import { presentAccountRateLimits, unavailableAccountRateLimits } from "./account/rate-limits";
import { LiveCatalogService } from "./catalog/live-catalog-service";
import { createCodexBackend } from "./codex/index";
import { CodexThreadObservationStore } from "./codex/thread-observation-store";
import type { CodexBackend } from "./codex/types";
import { loadConfig, type AppConfig } from "./config/env";
import { readRepoConfigOptional, type RepoConfig } from "./config/repos";
import { PushNotificationService } from "./notifications/push-notification-service";
import { CodexDebugLog } from "./observability/codex-debug-log";
import { RealtimeGateway } from "./realtime/realtime-gateway";
import { RunService } from "./runs/run-service";
import { SessionUnreadService } from "./sessions/session-unread-service";
import { ImageUploadService } from "./uploads/image-upload-service";
import { createIsolatedGitEnv } from "./utils/git-env";

const filterSchema = z.enum(["all", "running", "unread", "completed", "interrupted", "error", "archived"]).optional();
const filePreviewMaxTextBytes = 256 * 1024;
const filePreviewMaxImageBytes = 2 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const renameSessionSchema = z.object({
  title: z.string().trim().min(1)
});
const savePushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1)
  }),
  userAgent: z.string().optional(),
  platform: z.string().optional()
});
const deletePushSubscriptionSchema = z.object({
  endpoint: z.string().url()
});
const codexCommandDecisionSchema = z.enum(["accept", "acceptForSession", "decline", "cancel"]);
const codexApprovalPolicySchema = z.enum(["untrusted", "on-failure", "on-request", "never"]);
const codexSandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const codexServiceTierSchema = z.enum(["fast", "flex"]);
const codexPermissionProfileSchema = z.object({
  network: z
    .object({
      enabled: z.boolean().nullable()
    })
    .optional(),
  fileSystem: z
    .object({
      read: z.array(z.string()).nullable(),
      write: z.array(z.string()).nullable()
    })
    .optional()
});
const codexRunSettingsSchema = z.object({
  approvalPolicy: codexApprovalPolicySchema.nullable().optional(),
  sandbox: codexSandboxSchema.nullable().optional(),
  serviceTier: codexServiceTierSchema.nullable().optional(),
  model: z.string().trim().min(1).nullable().optional()
});
const simulateCodexRequestSchema = z.object({
  scenario: z.enum([
    "command_approval",
    "file_change_approval",
    "permissions_approval",
    "request_user_input",
    "mcp_elicitation"
  ])
});
const sessionFilePreviewSchema = z.object({
  path: z.string().trim().min(1),
  diff: z.string().optional().nullable(),
  changeKind: z.enum(["add", "delete", "update"]).optional().nullable(),
  movePath: z.string().trim().min(1).optional().nullable(),
  selection: z
    .object({
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1).optional().nullable(),
      startColumn: z.number().int().min(1).optional().nullable(),
      endColumn: z.number().int().min(1).optional().nullable()
    })
    .optional()
    .nullable()
});
const codexPendingRequestResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("command_approval"),
    decision: codexCommandDecisionSchema
  }),
  z.object({
    type: z.literal("file_change_approval"),
    decision: codexCommandDecisionSchema
  }),
  z.object({
    type: z.literal("permissions_approval"),
    permissions: codexPermissionProfileSchema,
    scope: z.enum(["turn", "session"])
  }),
  z.object({
    type: z.literal("request_user_input"),
    answers: z.record(
      z.string(),
      z.object({
        answers: z.array(z.string())
      })
    )
  }),
  z.object({
    type: z.literal("mcp_elicitation"),
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.unknown().nullable(),
    meta: z.unknown().nullable().optional()
  })
]);

type BuildAppOverrides = {
  config?: AppConfig;
  codex?: CodexBackend;
  repoConfig?: RepoConfig[];
};

export async function buildApp(overrides: BuildAppOverrides = {}) {
  const config = overrides.config ?? loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  const createSessionSchema = z.object({
    repoId: z.string().min(1),
    title: z.string().trim().optional()
  });
  const imageAttachmentSchema = z.object({
    name: z.string().trim().min(1),
    mimeType: z.string().trim().startsWith("image/"),
    dataUrl: z.string().startsWith("data:image/"),
    size: z.number().int().positive().max(config.maxImageAttachmentBytes)
  });
  const createRunSchema = z
    .object({
      sessionId: z.string().min(1).optional(),
      repoId: z.string().min(1).optional(),
      prompt: z.string().default(""),
      attachments: z.array(imageAttachmentSchema).max(config.maxImageAttachments).default([]),
      codex: codexRunSettingsSchema.optional()
    })
    .refine((value) => Boolean(value.sessionId || value.repoId), {
      message: "sessionId or repoId is required"
    })
    .refine((value) => value.prompt.trim().length > 0 || value.attachments.length > 0, {
      message: "Prompt or image attachment is required"
    });

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info"
    }
  });

  const codexDebugLog = new CodexDebugLog(config.codexDebugLogFile, {
    bridgePid: process.pid,
    listenPort: config.port
  });
  app.log.info({ path: config.codexDebugLogFile }, "Codex app-server debug log enabled");

  const codex = overrides.codex ?? (await createCodexBackend(config.codexMode, app.log, codexDebugLog, config.codexHomeDir));
  const threadObservations = new CodexThreadObservationStore();
  const uploads = new ImageUploadService(
    config.uploadsDir,
    "/api/uploads/",
    config.maxImageAttachments,
    config.maxImageAttachmentBytes
  );
  const repoConfig = overrides.repoConfig ?? readRepoConfigOptional(config.reposFile);
  const catalog = new LiveCatalogService(codex, repoConfig, uploads, threadObservations);
  const pushNotifications = new PushNotificationService(config.stateFile, config, app.log);
  const unread = new SessionUnreadService(`${config.dataDir}/session-read-state.json`);
  const realtime = new RealtimeGateway((event: ClientWsEvent) => {
    if (event.type === "ping") {
      realtime.broadcastPong();
      return;
    }

    if (event.type === "session.read") {
      void markSessionRead(event.sessionId).catch((error) => {
        app.log.warn({ err: error, sessionId: event.sessionId }, "Unable to mark session as read from websocket event");
      });
    }
  });
  const runs = new RunService(
    config,
    catalog,
    realtime,
    codex,
    uploads,
    pushNotifications,
    unread,
    app.log,
    codexDebugLog,
    undefined,
    threadObservations
  );
  const withPendingRequestCount = (session: SessionSummary) => {
    const pendingRequestCount = codex.listPendingRequests(session.id).length;
    return session.pendingRequestCount === pendingRequestCount ? session : { ...session, pendingRequestCount };
  };
  const withPendingRequestCounts = (sessions: SessionSummary[]) => {
    const counts = new Map<string, number>();

    for (const request of codex.listPendingRequests()) {
      counts.set(request.sessionId, (counts.get(request.sessionId) ?? 0) + 1);
    }

    return sessions.map((session) => {
      const pendingRequestCount = counts.get(session.id) ?? 0;
      return session.pendingRequestCount === pendingRequestCount ? session : { ...session, pendingRequestCount };
    });
  };
  const presentSession = (session: SessionSummary) =>
    withPendingRequestCount(unread.presentSessionSummary(runs.presentSessionSummary(session)));
  const presentSessions = (sessions: SessionSummary[]) =>
    withPendingRequestCounts(unread.presentSessionSummaries(runs.presentSessionSummaries(sessions)));
  const presentDetail = (detail: SessionDetail) => {
    const presented = unread.presentSessionDetail(runs.presentSessionDetail(detail));
    const session = withPendingRequestCount(presented.session);
    return session === presented.session ? presented : { ...presented, session };
  };
  const listPresentedSessions = async ({
    repoId,
    search,
    filter
  }: {
    repoId?: string;
    search?: string;
    filter?: SessionFilter;
  }) => {
    const sessions = await catalog.listSessions(repoId, {
      search,
      filter: filter === "archived" ? filter : undefined,
      hydrateAll: filter !== undefined && filter !== "all"
    });
    return presentSessions(sessions).filter((session) => matchesSessionFilter(session, filter));
  };

  async function markSessionRead(sessionId: string) {
    const detail = await catalog.getSessionDetail(sessionId);
    const changed = unread.markRead(sessionId);
    if (!changed) {
      return false;
    }

    const presented = presentDetail(detail);
    realtime.broadcastSession(presented.session);
    realtime.broadcastSessionDetail(presented);
    return true;
  }

  await app.register(cors, {
    origin: true,
    credentials: true
  });
  await app.register(websocket);
  await app.register(fastifyStatic, {
    root: config.uploadsDir,
    prefix: "/api/uploads/",
    decorateReply: false
  });

  app.get("/healthz", async () => ({
    ok: true,
    stateOk: true,
    codex: codex.getState(),
    metrics: {
      activeWebSockets: realtime.getConnectionCount(),
      activeRuns: runs.getActiveRunsCount()
    },
    devTools: {
      codexRequestSimulator: config.devSimulatorEnabled
    }
  }));

  app.get("/api/notifications/config", async (): Promise<NotificationsConfigResponse> =>
    pushNotifications.getClientConfig()
  );

  app.get("/api/account/rate-limits", async (): Promise<AccountRateLimitsResponse> => {
    if (codex.getState().mode !== "real") {
      return unavailableAccountRateLimits("Usage limits are not available in mock mode.");
    }

    try {
      const rateLimits = await codex.readAccountRateLimits();
      if (!rateLimits) {
        return unavailableAccountRateLimits("Usage limits are not available right now.");
      }

      return {
        available: true,
        rateLimits: presentAccountRateLimits(rateLimits),
        error: null
      };
    } catch (error) {
      app.log.warn({ err: error }, "Unable to read account rate limits");
      return unavailableAccountRateLimits("Usage limits are not available right now.");
    }
  });

  app.get("/api/codex/models", async (): Promise<CodexModelsResponse> => ({
    models: await codex.listModels()
  }));

  app.post("/api/notifications/subscriptions", async (request) => {
    const body = savePushSubscriptionSchema.parse(request.body) as SavePushSubscriptionRequest;
    pushNotifications.saveSubscription(body);
    return { ok: true };
  });

  app.delete("/api/notifications/subscriptions", async (request) => {
    const body = deletePushSubscriptionSchema.parse(request.body) as DeletePushSubscriptionRequest;
    pushNotifications.deleteSubscription(body.endpoint);
    return { ok: true };
  });

  app.get("/api/repos", async () => ({
    repos: await catalog.listRepos()
  }));

  app.get("/api/repos/:repoId", async (request, reply) => {
    const params = z.object({ repoId: z.string().min(1) }).parse(request.params);
    const repo = await catalog.getRepo(params.repoId);
    if (!repo) {
      return reply.code(404).send({ message: "Repository not found" });
    }
    return repo;
  });

  app.post("/api/repos/:repoId/select", async (request, reply) => {
    const params = z.object({ repoId: z.string().min(1) }).parse(request.params);
    const repo = await catalog.getRepo(params.repoId);
    if (!repo) {
      return reply.code(404).send({ message: "Repository not found" });
    }
    return { repo };
  });

  app.get("/api/sessions/search", async (request) => {
    const query = z
      .object({
        repoId: z.string().min(1).optional(),
        q: z.string().default(""),
        filter: filterSchema
      })
      .parse(request.query);
    return {
      sessions: await listPresentedSessions({
        repoId: query.repoId,
        search: query.q,
        filter: query.filter as SessionFilter | undefined
      })
    };
  });

  app.get("/api/sessions", async (request) => {
    const query = z
      .object({
        repoId: z.string().min(1).optional(),
        filter: filterSchema
      })
      .parse(request.query);
    return {
      sessions: await listPresentedSessions({
        repoId: query.repoId,
        filter: query.filter as SessionFilter | undefined
      })
    };
  });

  app.get("/api/sessions/:sessionId", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const detail = presentDetail(await catalog.getSessionDetail(params.sessionId));
    if (!detail) {
      return reply.code(404).send({ message: "Session not found" });
    }
    return detail;
  });

  app.get("/api/sessions/:sessionId/messages", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const detail = await catalog.getSessionDetail(params.sessionId);
    if (!detail) {
      return reply.code(404).send({ message: "Session not found" });
    }
    return {
      messages: await catalog.listMessages(params.sessionId)
    };
  });

  app.post("/api/sessions/:sessionId/files/preview", async (request, reply): Promise<SessionFilePreviewResponse> => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const body = sessionFilePreviewSchema.parse(request.body) as SessionFilePreviewRequest;

    let thread;
    try {
      thread = await catalog.getThread(params.sessionId);
    } catch {
      return reply.code(404).send({ message: "Session not found" }) as never;
    }

    const repoRoot = await resolveSessionRepoRoot(thread.cwd);
    const previewPath = body.movePath ?? body.path;

    let resolvedPath: string;
    try {
      resolvedPath = resolveSessionPreviewPath(previewPath, thread.cwd, repoRoot);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Unable to resolve file path" }) as never;
    }

    const snapshot = readPreviewPathSnapshot(resolvedPath);
    if (snapshot.type === "missing") {
      return {
        path: body.path,
        resolvedPath,
        contentStatus: "missing",
        mediaType: guessFilePreviewMediaType(resolvedPath, false),
        sizeBytes: null,
        isMarkdown: false,
        text: null,
        imageDataUrl: null,
        diff: body.diff ?? null,
        changeKind: body.changeKind ?? null,
        movePath: body.movePath ?? null,
        selection: body.selection ?? null
      };
    }

    if (snapshot.type === "directory") {
      return {
        path: body.path,
        resolvedPath,
        contentStatus: "directory",
        mediaType: null,
        sizeBytes: null,
        isMarkdown: false,
        text: null,
        imageDataUrl: null,
        diff: body.diff ?? null,
        changeKind: body.changeKind ?? null,
        movePath: body.movePath ?? null,
        selection: body.selection ?? null
      };
    }

    let metadata;
    try {
      metadata = await codex.getFileMetadata(resolvedPath);
    } catch (error) {
      app.log.warn({ err: error, path: resolvedPath }, "Unable to read file metadata from Codex");
      metadata = {
        isDirectory: false,
        isFile: true,
        createdAtMs: null,
        modifiedAtMs: null,
        sizeBytes: snapshot.sizeBytes
      };
    }

    if (metadata.isDirectory) {
      return {
        path: body.path,
        resolvedPath,
        contentStatus: "directory",
        mediaType: null,
        sizeBytes: null,
        isMarkdown: false,
        text: null,
        imageDataUrl: null,
        diff: body.diff ?? null,
        changeKind: body.changeKind ?? null,
        movePath: body.movePath ?? null,
        selection: body.selection ?? null
      };
    }

    let file;
    try {
      file = await codex.readFile(resolvedPath);
    } catch (error) {
      app.log.warn({ err: error, path: resolvedPath }, "Unable to read file contents from Codex");
      return reply.code(400).send({ message: "Unable to read file contents" }) as never;
    }

    const buffer = Buffer.from(file.dataBase64, "base64");
    const sizeBytes = metadata.sizeBytes ?? snapshot.sizeBytes ?? buffer.byteLength;
    const isMarkdown = isMarkdownPreviewPath(resolvedPath);
    const mediaType = guessFilePreviewMediaType(resolvedPath, isMarkdown);

    const isPreviewableImage = isPreviewableImageMediaType(mediaType);
    const filePreviewMaxBytes = isPreviewableImage ? filePreviewMaxImageBytes : filePreviewMaxTextBytes;

    if (sizeBytes > filePreviewMaxBytes) {
      return {
        path: body.path,
        resolvedPath,
        contentStatus: "too_large",
        mediaType,
        sizeBytes,
        isMarkdown,
        text: null,
        imageDataUrl: null,
        diff: body.diff ?? null,
        changeKind: body.changeKind ?? null,
        movePath: body.movePath ?? null,
        selection: body.selection ?? null
      };
    }

    if (isPreviewableImage) {
      return {
        path: body.path,
        resolvedPath,
        contentStatus: "ok",
        mediaType,
        sizeBytes,
        isMarkdown: false,
        text: null,
        imageDataUrl: `data:${mediaType};base64,${file.dataBase64}`,
        diff: body.diff ?? null,
        changeKind: body.changeKind ?? null,
        movePath: body.movePath ?? null,
        selection: body.selection ?? null
      };
    }

    const previewText = decodePreviewText(buffer);
    if (previewText === null) {
      return {
        path: body.path,
        resolvedPath,
        contentStatus: "binary",
        mediaType,
        sizeBytes,
        isMarkdown: false,
        text: null,
        imageDataUrl: null,
        diff: body.diff ?? null,
        changeKind: body.changeKind ?? null,
        movePath: body.movePath ?? null,
        selection: body.selection ?? null
      };
    }

    return {
      path: body.path,
      resolvedPath,
      contentStatus: "ok",
      mediaType,
      sizeBytes,
      isMarkdown,
      text: previewText,
      imageDataUrl: null,
      diff: body.diff ?? null,
      changeKind: body.changeKind ?? null,
      movePath: body.movePath ?? null,
      selection: body.selection ?? null
    };
  });

  app.get("/api/sessions/:sessionId/codex/requests", async (request, reply): Promise<PendingCodexRequestsResponse> => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const detail = await catalog.getSessionDetail(params.sessionId);
    if (!detail) {
      return reply.code(404).send({ message: "Session not found" }) as never;
    }

    return {
      requests: codex.listPendingRequests(params.sessionId)
    };
  });

  app.post("/api/sessions", async (request, reply) => {
    const body = createSessionSchema.parse(request.body) as CreateSessionRequest;
    try {
      const session = presentSession(await catalog.createSession(body.repoId));
      return { session };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Unable to create session" });
    }
  });

  app.post("/api/sessions/:sessionId/select", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const detail = presentDetail(await catalog.getSessionDetail(params.sessionId));
    if (!detail) {
      return reply.code(404).send({ message: "Session not found" });
    }
    return detail;
  });

  app.post("/api/sessions/:sessionId/archive", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const detail = presentDetail(await catalog.getSessionDetail(params.sessionId));
    if (!detail) {
      return reply.code(404).send({ message: "Session not found" });
    }

    if (detail.activeRun) {
      return reply.code(409).send({ message: "Cannot archive a session with an active run" });
    }

    try {
      await catalog.archiveSession(params.sessionId);
      const updated = presentDetail(await catalog.getSessionDetail(params.sessionId));
      realtime.broadcastSession(updated.session);
      realtime.broadcastSessionDetail(updated);
      realtime.broadcastRepos(await catalog.listRepos());
      return updated;
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Unable to archive session" });
    }
  });

  app.post("/api/sessions/:sessionId/restore", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const detail = presentDetail(await catalog.getSessionDetail(params.sessionId));
    if (!detail) {
      return reply.code(404).send({ message: "Session not found" });
    }

    try {
      const restored = presentDetail(await catalog.restoreSession(params.sessionId));
      realtime.broadcastSession(restored.session);
      realtime.broadcastSessionDetail(restored);
      realtime.broadcastRepos(await catalog.listRepos());
      return restored;
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Unable to restore session" });
    }
  });

  app.post("/api/sessions/:sessionId/read", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);

    try {
      await markSessionRead(params.sessionId);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Unable to mark session as read" });
    }
  });

  app.patch("/api/sessions/:sessionId", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const body = renameSessionSchema.parse(request.body);

    try {
      const updated = presentDetail(await catalog.renameSession(params.sessionId, body.title));
      realtime.broadcastSession(updated.session);
      realtime.broadcastSessionDetail(updated);
      return updated;
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Unable to rename session" });
    }
  });

  app.post(
    "/api/runs",
    {
      bodyLimit:
        config.maxPromptLength +
        Math.ceil(config.maxImageAttachments * config.maxImageAttachmentBytes * 1.5) +
        1024 * 1024
    },
    async (request, reply) => {
      try {
        const body = createRunSchema.parse(request.body) as CreateRunRequest;
        const run = await runs.start(body);
        return { run };
      } catch (error) {
        return reply.code(400).send({ message: error instanceof Error ? error.message : "Unable to start run" });
      }
    }
  );

  app.get("/api/runs/:runId", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).parse(request.params);
    const run = runs.get(params.runId);
    if (!run) {
      return reply.code(404).send({ message: "Run not found" });
    }
    return { run };
  });

  app.post("/api/runs/:runId/interrupt", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).parse(request.params);
    const run = await runs.interrupt(params.runId);
    if (!run) {
      return reply.code(404).send({ message: "Run not found or not interruptible" });
    }
    return { ok: true };
  });

  app.post("/api/codex/requests/:requestId/respond", async (request, reply) => {
    const params = z.object({ requestId: z.string().min(1) }).parse(request.params);

    try {
      const body = codexPendingRequestResponseSchema.parse(request.body) as CodexPendingRequestResponse;
      const responded = await codex.respondToRequest(params.requestId, body);
      if (!responded) {
        return reply.code(404).send({ message: "Codex request not found" });
      }

      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Unable to respond to Codex request" });
    }
  });

  app.post("/api/dev/sessions/:sessionId/codex/requests", async (request, reply): Promise<SimulateCodexRequestResponse> => {
    if (!config.devSimulatorEnabled) {
      return reply.code(404).send({ message: "Dev Codex simulator is not enabled." }) as never;
    }

    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const detail = await catalog.getSessionDetail(params.sessionId);
    if (!detail) {
      return reply.code(404).send({ message: "Session not found" }) as never;
    }

    try {
      const body = simulateCodexRequestSchema.parse(request.body) as SimulateCodexRequestRequest;
      const thread = await catalog.getThread(params.sessionId);
      const simulated = await codex.simulatePendingRequest({
        sessionId: params.sessionId,
        threadId: thread.id,
        cwd: thread.cwd,
        scenario: body.scenario
      });
      return { request: simulated };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Unable to simulate Codex request" }) as never;
    }
  });

  app.route({
    method: "GET",
    url: "/ws",
    handler: async (_request, reply) => {
      reply.code(426).send({ message: "Upgrade required" });
    },
    wsHandler: (socket) => {
      realtime.register(socket, codex.getState().mode);
    }
  });

  if (fs.existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: "/"
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api") || request.url.startsWith("/ws")) {
        return reply.code(404).send({ message: "Not found" });
      }
      return reply.type("text/html").sendFile("index.html");
    });
  }

  app.addHook("onClose", async () => {
    pushNotifications.close();
    await codex.stop();
    codexDebugLog.close();
  });

  return {
    app,
    config,
    realtime
  };
}

function normalizePreviewPathRoot(candidate: string) {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function normalizeRequestedPreviewPath(rawPath: string) {
  let next = rawPath.trim();
  if (!next) {
    throw new Error("File path is required");
  }

  if (next.startsWith("<") && next.endsWith(">")) {
    next = next.slice(1, -1).trim();
  }

  const fragmentOrQueryIndex = next.search(/[?#]/);
  if (fragmentOrQueryIndex >= 0) {
    next = next.slice(0, fragmentOrQueryIndex);
  }

  if (next.startsWith("file://")) {
    return fileURLToPath(next);
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(next)) {
    throw new Error("Only local file paths can be previewed");
  }

  try {
    next = decodeURIComponent(next);
  } catch {
    // Preserve the original path when the link contains invalid escapes.
  }

  if (!next) {
    throw new Error("File path is required");
  }

  return next;
}

function isWithinPreviewRoot(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveSessionPreviewPath(rawPath: string, cwd: string, repoRoot: string) {
  const requestedPath = normalizeRequestedPreviewPath(rawPath);
  const allowedRoots = [...new Set([normalizePreviewPathRoot(cwd), normalizePreviewPathRoot(repoRoot)])];

  if (path.isAbsolute(requestedPath)) {
    const absoluteCandidate = normalizePreviewPathRoot(requestedPath);
    if (!allowedRoots.some((root) => isWithinPreviewRoot(absoluteCandidate, root))) {
      throw new Error("File path is outside this session's workspace");
    }
    return absoluteCandidate;
  }

  const candidateBases = [...new Set([cwd, repoRoot])];
  const candidates = candidateBases
    .map((basePath) => normalizePreviewPathRoot(path.resolve(basePath, requestedPath)))
    .filter((candidate) => allowedRoots.some((root) => isWithinPreviewRoot(candidate, root)));

  if (candidates.length === 0) {
    throw new Error("File path is outside this session's workspace");
  }

  const existingCandidate = candidates.find((candidate) => readPreviewPathSnapshot(candidate).type !== "missing");
  return existingCandidate ?? candidates[0]!;
}

async function resolveSessionRepoRoot(cwd: string) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      env: createIsolatedGitEnv()
    });
    return stdout.trim() || cwd;
  } catch {
    return cwd;
  }
}

function readPreviewPathSnapshot(candidate: string) {
  try {
    const stat = fs.statSync(candidate);
    if (stat.isDirectory()) {
      return { type: "directory" as const, sizeBytes: null };
    }
    if (stat.isFile()) {
      return { type: "file" as const, sizeBytes: stat.size };
    }
    return { type: "missing" as const, sizeBytes: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { type: "missing" as const, sizeBytes: null };
    }
    throw error;
  }
}

function isMarkdownPreviewPath(candidate: string) {
  const basename = path.basename(candidate).toLowerCase();
  const extension = path.extname(basename);
  return extension === ".md" || extension === ".mdx" || extension === ".markdown" || basename === "readme";
}

function guessFilePreviewMediaType(candidate: string, isMarkdown: boolean) {
  if (isMarkdown) {
    return "text/markdown";
  }

  switch (path.extname(candidate).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".json":
      return "application/json";
    case ".yml":
    case ".yaml":
      return "application/yaml";
    case ".html":
    case ".htm":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "text/javascript";
    case ".ts":
    case ".tsx":
      return "text/typescript";
    case ".jsx":
      return "text/jsx";
    case ".sh":
      return "application/x-sh";
    case ".sql":
      return "application/sql";
    case ".toml":
      return "application/toml";
    case ".txt":
    default:
      return "text/plain";
  }
}

function isPreviewableImageMediaType(mediaType: string | null) {
  return mediaType === "image/png" || mediaType === "image/jpeg" || mediaType === "image/webp" || mediaType === "image/gif";
}

function decodePreviewText(buffer: Buffer) {
  if (buffer.length === 0) {
    return "";
  }

  if (buffer.includes(0)) {
    return null;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}
