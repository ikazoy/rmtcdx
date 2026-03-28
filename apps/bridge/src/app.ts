import fs from "node:fs";
import path from "node:path";

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";

import type {
  ClientWsEvent,
  CreateRunRequest,
  CreateSessionRequest,
  SessionFilter
} from "../../../packages/shared-types/src/index";
import { createCodexBackend } from "./codex/index";
import { loadConfig } from "./config/env";
import { readRepoConfig } from "./config/repos";
import { Database } from "./db/database";
import { RealtimeGateway } from "./realtime/realtime-gateway";
import { RepositoryService } from "./repos/repository-service";
import { RunService } from "./runs/run-service";
import { SessionService } from "./sessions/session-service";

const createSessionSchema = z.object({
  repoId: z.string().min(1),
  title: z.string().trim().optional()
});

const createRunSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.string().min(1)
});

const filterSchema = z.enum(["all", "running", "unread", "completed", "error"]).optional();

export async function buildApp() {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info"
    }
  });

  const repoConfig = readRepoConfig(config.reposFile);
  const db = new Database(config.dbFile);
  db.init();

  const repositories = new RepositoryService(db, repoConfig);
  repositories.sync();

  const sessions = new SessionService(db);
  const codex = await createCodexBackend(config.codexMode, app.log);
  const realtime = new RealtimeGateway((event: ClientWsEvent) => {
    if (event.type === "ping") {
      realtime.broadcastPong();
      return;
    }
    if (event.type === "session.read") {
      const detail = sessions.markRead(event.sessionId);
      if (detail) {
        realtime.broadcastSession(detail.session);
        realtime.broadcastSessionDetail(detail);
      }
    }
  });
  const runs = new RunService(config, db, repositories, sessions, realtime, codex);

  await app.register(cors, {
    origin: true,
    credentials: true
  });
  await app.register(websocket);

  app.get("/healthz", async () => ({
    ok: true,
    dbOk: db.getDbOk(),
    codex: codex.getState(),
    metrics: {
      activeWebSockets: realtime.getConnectionCount(),
      activeRuns: db.getActiveRunsCount()
    }
  }));

  app.get("/api/repos", async () => ({
    repos: await repositories.list()
  }));

  app.get("/api/repos/:repoId", async (request, reply) => {
    const params = z.object({ repoId: z.string().min(1) }).parse(request.params);
    const repo = await repositories.get(params.repoId);
    if (!repo) {
      return reply.code(404).send({ message: "Repository not found" });
    }
    return repo;
  });

  app.post("/api/repos/:repoId/select", async (request, reply) => {
    const params = z.object({ repoId: z.string().min(1) }).parse(request.params);
    const repo = await repositories.get(params.repoId);
    if (!repo) {
      return reply.code(404).send({ message: "Repository not found" });
    }
    return { repo };
  });

  app.get("/api/sessions/search", async (request) => {
    const query = z
      .object({
        repoId: z.string().min(1),
        q: z.string().default(""),
        filter: filterSchema
      })
      .parse(request.query);
    return {
      sessions: sessions.list(query.repoId, { search: query.q, filter: query.filter as SessionFilter | undefined })
    };
  });

  app.get("/api/sessions", async (request) => {
    const query = z
      .object({
        repoId: z.string().min(1),
        filter: filterSchema
      })
      .parse(request.query);
    return {
      sessions: sessions.list(query.repoId, { filter: query.filter as SessionFilter | undefined })
    };
  });

  app.get("/api/sessions/:sessionId", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const detail = sessions.get(params.sessionId);
    if (!detail) {
      return reply.code(404).send({ message: "Session not found" });
    }
    return detail;
  });

  app.get("/api/sessions/:sessionId/messages", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const detail = sessions.get(params.sessionId);
    if (!detail) {
      return reply.code(404).send({ message: "Session not found" });
    }
    return {
      messages: sessions.listMessages(params.sessionId)
    };
  });

  app.post("/api/sessions", async (request) => {
    const body = createSessionSchema.parse(request.body) as CreateSessionRequest;
    return {
      session: sessions.create(body.repoId, body.title)
    };
  });

  app.post("/api/sessions/:sessionId/select", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const detail = sessions.get(params.sessionId);
    if (!detail) {
      return reply.code(404).send({ message: "Session not found" });
    }
    return detail;
  });

  app.post("/api/sessions/:sessionId/archive", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const detail = sessions.archive(params.sessionId);
    if (!detail) {
      return reply.code(404).send({ message: "Session not found" });
    }
    realtime.broadcastSession(detail.session);
    realtime.broadcastSessionDetail(detail);
    return { ok: true };
  });

  app.post("/api/sessions/:sessionId/read", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const detail = sessions.markRead(params.sessionId);
    if (!detail) {
      return reply.code(404).send({ message: "Session not found" });
    }
    realtime.broadcastSession(detail.session);
    realtime.broadcastSessionDetail(detail);
    return { ok: true };
  });

  app.post("/api/runs", async (request, reply) => {
    try {
      const body = createRunSchema.parse(request.body) as CreateRunRequest;
      const run = await runs.start(body.sessionId, body.prompt);
      return { run };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Unable to start run" });
    }
  });

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
      return reply.sendFile(path.join(config.webDistDir, "index.html"));
    });
  }

  app.addHook("onClose", async () => {
    await codex.stop();
  });

  return {
    app,
    config
  };
}
