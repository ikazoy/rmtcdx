import fs from "node:fs";

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";

import type {
  AccountRateLimitsResponse,
  ClientWsEvent,
  CreateRunRequest,
  CreateSessionRequest,
  DeletePushSubscriptionRequest,
  NotificationsConfigResponse,
  SavePushSubscriptionRequest,
  SessionDetail,
  SessionFilter,
  SessionSummary
} from "../../../packages/shared-types/src/index";
import { presentAccountRateLimits, unavailableAccountRateLimits } from "./account/rate-limits";
import { LiveCatalogService } from "./catalog/live-catalog-service";
import { createCodexBackend } from "./codex/index";
import { loadConfig } from "./config/env";
import { readRepoConfigOptional } from "./config/repos";
import { PushNotificationService } from "./notifications/push-notification-service";
import { CodexDebugLog } from "./observability/codex-debug-log";
import { RealtimeGateway } from "./realtime/realtime-gateway";
import { RunService } from "./runs/run-service";
import { ImageUploadService } from "./uploads/image-upload-service";

const filterSchema = z.enum(["all", "running", "unread", "completed", "error", "archived"]).optional();
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

export async function buildApp() {
  const config = loadConfig();
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
      attachments: z.array(imageAttachmentSchema).max(config.maxImageAttachments).default([])
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

  const codex = await createCodexBackend(config.codexMode, app.log, codexDebugLog);
  const uploads = new ImageUploadService(
    config.uploadsDir,
    "/api/uploads/",
    config.maxImageAttachments,
    config.maxImageAttachmentBytes
  );
  const repoConfig = readRepoConfigOptional(config.reposFile);
  const catalog = new LiveCatalogService(codex, repoConfig, uploads);
  const pushNotifications = new PushNotificationService(config.dbFile, config, app.log);
  const realtime = new RealtimeGateway((event: ClientWsEvent) => {
    if (event.type === "ping") {
      realtime.broadcastPong();
    }
  });
  const runs = new RunService(config, catalog, realtime, codex, uploads, pushNotifications, app.log);
  const presentSessions = (sessions: SessionSummary[]) => runs.presentSessionSummaries(sessions);
  const presentDetail = (detail: SessionDetail) => runs.presentSessionDetail(detail);

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
    dbOk: true,
    codex: codex.getState(),
    metrics: {
      activeWebSockets: realtime.getConnectionCount(),
      activeRuns: runs.getActiveRunsCount()
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
      sessions: presentSessions(await catalog.listSessions(query.repoId, {
        search: query.q,
        filter: query.filter as SessionFilter | undefined
      }))
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
      sessions: presentSessions(await catalog.listSessions(query.repoId, {
        filter: query.filter as SessionFilter | undefined
      }))
    };
  });

  app.get("/api/sessions/:sessionId", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const detail = presentDetail(await catalog.getSessionDetail(params.sessionId));
    if (!detail) {
      return reply.code(404).send({ message: "Session not found" });
    }
    const sessionRuns = runs.getSessionRuns(params.sessionId, detail);
    return {
      ...detail,
      activeRun: sessionRuns.activeRun,
      latestRun: sessionRuns.latestRun
    };
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

  app.post("/api/sessions", async (request, reply) => {
    const body = createSessionSchema.parse(request.body) as CreateSessionRequest;
    try {
      const session = runs.presentSessionSummary(await catalog.createSession(body.repoId));
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
    const sessionRuns = runs.getSessionRuns(params.sessionId, detail);
    return {
      ...detail,
      activeRun: sessionRuns.activeRun,
      latestRun: sessionRuns.latestRun
    };
  });

  app.post("/api/sessions/:sessionId/archive", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const detail = presentDetail(await catalog.getSessionDetail(params.sessionId));
    if (!detail) {
      return reply.code(404).send({ message: "Session not found" });
    }

    const sessionRuns = runs.getSessionRuns(params.sessionId, detail);
    if (sessionRuns.activeRun) {
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

  app.post("/api/sessions/:sessionId/read", async () => {
    return { ok: true };
  });

  app.patch("/api/sessions/:sessionId", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const body = renameSessionSchema.parse(request.body);

    try {
      return presentDetail(await catalog.renameSession(params.sessionId, body.title));
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
    config
  };
}
