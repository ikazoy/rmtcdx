import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { CodexAvailableModel, CodexPendingRequest, CodexPendingRequestResponse, CodexReasoningEffort } from "@codex-remote/shared-types";

import type {
  CodexAccountRateLimits,
  CodexBackend,
  CodexBridgeEvent,
  CodexPlanType,
  CodexRateLimitCredits,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  CodexRuntimeState,
  CodexThread,
  EnsureThreadParams,
  ListThreadsParams,
  LoggerLike,
  SimulatePendingRequestParams,
  StartRunParams
} from "./types";
import type { CodexDebugLog } from "../observability/codex-debug-log";
import { parseBridgeNotification } from "./parsers/bridge-events";
import { parsePendingServerRequest, resultForPendingRequestResponse } from "./parsers/pending-requests";

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
};

type RunMapping = {
  sessionId: string;
  runId: string;
};

type PendingServerRequest = {
  rpcId: number | string | null;
  method: string;
  source: "server" | "simulated";
  request: CodexPendingRequest;
};

export class RealCodexClient extends EventEmitter implements CodexBackend {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
  private readonly runByTurn = new Map<string, RunMapping>();
  private readonly sessionByThread = new Map<string, string>();
  private readonly activeTurnIds = new Set<string>();
  private restarting = false;
  private stopped = false;
  private ready = false;
  private restarts = 0;
  private lastError: string | undefined;

  constructor(
    private readonly logger: LoggerLike,
    private readonly debugLog?: CodexDebugLog
  ) {
    super();
  }

  async start() {
    if (this.ready && this.child) {
      this.debugLog?.write("start.skip_ready", {
        pid: this.child.pid ?? null
      });
      return;
    }

    this.stopped = false;
    this.debugLog?.write("start.begin", {
      restarts: this.restarts
    });
    this.spawnChild();
    await this.initialize();
  }

  async stop() {
    this.debugLog?.write("stop.begin", {
      pendingRequests: this.pending.size,
      activeTurnCount: this.activeTurnIds.size,
      pid: this.child?.pid ?? null
    });
    this.stopped = true;
    this.ready = false;
    for (const [, pending] of this.pending) {
      pending.reject(new Error("Codex backend stopped"));
    }
    this.pending.clear();
    this.clearPendingServerRequests();

    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.debugLog?.write("stop.complete");
  }

  async createThread(cwd: string) {
    return this.requestNewThread(cwd);
  }

  async listThreads(params: ListThreadsParams = {}) {
    await this.ensureReady();

    const threads: CodexThread[] = [];
    let cursor: string | null = null;

    do {
      const response = await this.request("thread/list", {
        cursor,
        limit: params.limit ?? 100,
        archived: params.archived ?? false,
        cwd: params.cwd ?? null,
        searchTerm: params.searchTerm ?? null
      });

      const page = response as { data?: CodexThread[]; nextCursor?: string | null };
      threads.push(...(page.data ?? []));
      cursor = page.nextCursor ?? null;
    } while (cursor);

    return threads;
  }

  async readThread(threadId: string, options?: { includeTurns?: boolean }) {
    await this.ensureReady();
    const response = await this.request("thread/read", {
      threadId,
      includeTurns: options?.includeTurns ?? true
    });
    const thread = (response as { thread?: CodexThread }).thread;
    if (!thread) {
      throw new Error(`Codex did not return thread ${threadId}`);
    }
    return thread;
  }

  async listModels(): Promise<CodexAvailableModel[]> {
    await this.ensureReady();

    const models: CodexAvailableModel[] = [];
    let cursor: string | null = null;

    do {
      const response = await this.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: false
      });
      const page = this.extractModelListPage(response);
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);

    return models;
  }

  async readAccountRateLimits(): Promise<CodexAccountRateLimits | null> {
    await this.ensureReady();
    const response = await this.request("account/rateLimits/read", undefined);
    return this.extractAccountRateLimits(response);
  }

  async setThreadName(threadId: string, name: string) {
    await this.ensureReady();
    await this.request("thread/name/set", {
      threadId,
      name
    });
  }

  async archiveThread(threadId: string) {
    await this.ensureReady();
    await this.request("thread/archive", { threadId });
  }

  async unarchiveThread(threadId: string) {
    await this.ensureReady();
    await this.request("thread/unarchive", { threadId });
  }

  async ensureThread(params: EnsureThreadParams & { codex?: StartRunParams["codex"] }) {
    await this.ensureReady();
    if (params.threadId) {
      this.debugLog?.write("thread.resume.request", {
        threadId: params.threadId,
        sessionId: params.sessionId ?? null,
        cwd: params.cwd
      });
      const resumed = await this.request("thread/resume", {
        threadId: params.threadId,
        path: params.path ?? null,
        cwd: params.cwd,
        approvalPolicy: params.codex?.approvalPolicy ?? "on-request",
        sandbox: params.codex?.sandbox ?? "workspace-write",
        ...(params.codex?.serviceTier ? { serviceTier: params.codex.serviceTier } : {}),
        ...(params.codex?.model ? { model: params.codex.model } : {}),
        persistExtendedHistory: true
      });
      if (params.sessionId) {
        this.sessionByThread.set(params.threadId, params.sessionId);
      }
      const threadId = this.extractThreadId(resumed) ?? params.threadId;
      this.debugLog?.write("thread.resume.result", {
        threadId,
        requestedThreadId: params.threadId,
        sessionId: params.sessionId ?? null
      });
      return { threadId };
    }

    const { threadId } = await this.requestNewThread(params.cwd, params.codex);

    if (params.sessionId) {
      this.sessionByThread.set(threadId, params.sessionId);
    }
    return { threadId };
  }

  async startRun(params: StartRunParams) {
    const ensured = await this.ensureThread({
      sessionId: params.sessionId,
      cwd: params.cwd,
      threadId: params.threadId,
      codex: params.codex
    });
    this.debugLog?.write("turn.start.request", {
      runId: params.runId,
      sessionId: params.sessionId ?? ensured.threadId,
      threadId: ensured.threadId,
      inputCount: params.input.length
    });
    const response = await this.request("turn/start", {
      threadId: ensured.threadId,
      input: params.input,
      approvalPolicy: params.codex?.approvalPolicy ?? "on-request",
      sandboxPolicy: this.turnSandboxPolicy(params.codex?.sandbox),
      ...(params.codex?.serviceTier ? { serviceTier: params.codex.serviceTier } : {}),
      ...(params.codex?.model ? { model: params.codex.model } : {})
    });

    const turnId = this.extractTurnId(response);
    if (!turnId) {
      throw new Error("Codex did not return a turn id");
    }

    if (params.sessionId) {
      this.sessionByThread.set(ensured.threadId, params.sessionId);
    }
    this.runByTurn.set(turnId, {
      sessionId: params.sessionId ?? ensured.threadId,
      runId: params.runId
    });
    this.activeTurnIds.add(turnId);
    this.debugLog?.write("turn.start.result", {
      runId: params.runId,
      sessionId: params.sessionId ?? ensured.threadId,
      threadId: ensured.threadId,
      turnId,
      activeTurnCount: this.activeTurnIds.size
    });

    return {
      threadId: ensured.threadId,
      turnId
    };
  }

  async interruptRun(runId: string, _threadId: string, turnId: string) {
    await this.ensureReady();
    this.debugLog?.write("turn.interrupt.request", {
      runId,
      threadId: _threadId,
      turnId
    });
    await this.request("turn/interrupt", { turnId, threadId: _threadId });
    const mapping = this.runByTurn.get(turnId);
    if (mapping) {
      this.emitBridgeEvent({
        type: "run.interrupted",
        sessionId: mapping.sessionId,
        runId,
        turnId
      });
    }
  }

  listPendingRequests(sessionId?: string) {
    return [...this.pendingServerRequests.values()]
      .map((entry) => entry.request)
      .filter((request) => (sessionId ? request.sessionId === sessionId : true));
  }

  async respondToRequest(requestId: string, response: CodexPendingRequestResponse) {
    const pending = this.pendingServerRequests.get(requestId);
    if (!pending) {
      return null;
    }

    if (pending.request.type !== response.type) {
      throw new Error(`Codex request ${requestId} expects ${pending.request.type}, received ${response.type}`);
    }

    if (pending.source === "server" && pending.rpcId !== null) {
      this.send({
        id: pending.rpcId,
        result: resultForPendingRequestResponse(pending.request, response)
      });
    }
    this.pendingServerRequests.delete(requestId);
    this.emitBridgeEvent({
      type: "request.resolved",
      sessionId: pending.request.sessionId,
      requestId
    });
    return pending.request;
  }

  async simulatePendingRequest(params: SimulatePendingRequestParams) {
    const request = this.pendingRequestFromSimulation(params);
    this.pendingServerRequests.set(request.id, {
      rpcId: null,
      method: `dev/${params.scenario}`,
      source: "simulated",
      request
    });
    this.debugLog?.write("server.request.simulated", {
      requestId: request.id,
      scenario: params.scenario,
      sessionId: request.sessionId,
      threadId: request.threadId
    });
    this.emitBridgeEvent({
      type: "request.created",
      sessionId: request.sessionId,
      request
    });
    return request;
  }

  getState(): CodexRuntimeState {
    return {
      mode: "real",
      ready: this.ready,
      childAlive: this.child ? !this.child.killed : false,
      restarts: this.restarts,
      lastError: this.lastError
    };
  }

  private async ensureReady() {
    if (!this.ready || !this.child) {
      await this.start();
    }
  }

  private spawnChild() {
    this.debugLog?.write("child.spawn.request", {
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
      restarts: this.restarts
    });
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.buffer = "";

    child.on("spawn", () => {
      this.debugLog?.write("child.spawn", {
        pid: child.pid ?? null,
        restarts: this.restarts
      });
    });

    child.on("error", (error) => {
      this.lastError = error.message;
      this.debugLog?.write("child.error", {
        pid: child.pid ?? null,
        error
      });
      this.logger.error(error.message);
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newlineIndex = this.buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (line) {
          this.handleLine(line);
        }
        newlineIndex = this.buffer.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) {
        this.debugLog?.write("child.stderr", {
          pid: child.pid ?? null,
          text
        });
        this.logger.warn(text);
      }
    });
    child.stdout.on("close", () => {
      this.debugLog?.write("child.stdout.closed", {
        pid: child.pid ?? null
      });
    });
    child.stderr.on("close", () => {
      this.debugLog?.write("child.stderr.closed", {
        pid: child.pid ?? null
      });
    });

    child.on("close", (code, signal) => {
      this.debugLog?.write("child.close", {
        pid: child.pid ?? null,
        code: code ?? null,
        signal: signal ?? null
      });
    });

    child.on("exit", (code, signal) => {
      this.ready = false;
      const pid = child.pid ?? null;
      this.child = null;
      this.clearPendingServerRequests();
      this.lastError = `codex app-server exited (${code ?? "null"} / ${signal ?? "null"})`;
      this.debugLog?.write("child.exit", {
        pid,
        code: code ?? null,
        signal: signal ?? null,
        pendingRequests: this.pending.size,
        activeTurnIds: [...this.activeTurnIds],
        lastError: this.lastError
      });
      if (!this.stopped && !this.restarting) {
        this.restarts += 1;
        this.restarting = true;
        this.emitBridgeEvent({
          type: "backend.degraded",
          reason: this.lastError
        });
        this.debugLog?.write("child.restart.scheduled", {
          restarts: this.restarts,
          delayMs: 700,
          reason: this.lastError
        });
        setTimeout(() => {
          this.restarting = false;
          void this.start().catch((error: Error) => {
            this.lastError = error.message;
            this.debugLog?.write("child.restart.failed", {
              restarts: this.restarts,
              error
            });
            this.logger.error(error.message);
          });
        }, 700);
      }
    });
  }

  private async initialize() {
    this.debugLog?.write("initialize.request");
    await this.request("initialize", {
      clientInfo: {
        name: "codex_remote_web",
        title: "Codex Remote Web",
        version: "1.0.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });

    this.send({
      method: "initialized",
      params: {}
    });
    this.ready = true;
    this.debugLog?.write("initialize.ready", {
      pid: this.child?.pid ?? null
    });
  }

  private handleLine(line: string) {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.debugLog?.write("child.stdout.non_json", {
        line
      });
      this.logger.warn(`Non-JSON stdout from codex app-server: ${line}`);
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const requestId = Number(message.id);
      const pending = this.pending.get(requestId);
      if (!pending) {
        return;
      }
      this.pending.delete(requestId);
      if (message.error) {
        this.debugLog?.write("request.error", {
          requestId,
          method: pending.method,
          message: message.error.message ?? null
        });
        pending.reject(new Error(message.error.message ?? `Codex request failed: ${pending.method}`));
      } else {
        this.debugLog?.write("request.result", {
          requestId,
          method: pending.method
        });
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      if (this.handleServerRequest(message.id, message.method, message.params)) {
        return;
      }

      this.debugLog?.write("server.request.unhandled", {
        requestId: message.id,
        method: message.method
      });
      this.logger.warn(`Unhandled server request from codex app-server: ${message.method}`);
      this.send({
        id: message.id,
        error: {
          code: -32000,
          message: "Interactive server requests are not supported by this bridge"
        }
      });
      return;
    }

    if (message.method) {
      this.handleNotification(message.method, message.params);
    }
  }

  private handleNotification(method: string, params: unknown) {
    this.debugLog?.write("notification.received", { method, params });

    if (method === "serverRequest/resolved") {
      const payload = asObject(params);
      const requestId = payload?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        const internalRequestId = String(requestId);
        const pending = this.pendingServerRequests.get(internalRequestId);
        if (pending) {
          this.pendingServerRequests.delete(internalRequestId);
          this.emitBridgeEvent({
            type: "request.resolved",
            sessionId: pending.request.sessionId,
            requestId: internalRequestId
          });
        }
      }
      return;
    }

    const parsed = parseBridgeNotification(method, params, this.runByTurn);

    for (const entry of parsed.debugEntries) {
      this.debugLog?.write(entry.event, entry.fields);
    }

    if (parsed.finishedTurn) {
      this.markTurnFinished(parsed.finishedTurn.turnId, parsed.finishedTurn.status, parsed.finishedTurn.message);
    }

    for (const event of parsed.events) {
      this.emitBridgeEvent(event);
    }
  }

  private emitBridgeEvent(event: CodexBridgeEvent) {
    this.emit("event", event);
  }

  private handleServerRequest(id: number | string, method: string, params: unknown) {
    this.debugLog?.write("server.request.received", {
      requestId: String(id),
      method,
      params
    });
    const request = parsePendingServerRequest({
      requestId: id,
      method,
      params,
      createdAt: new Date().toISOString(),
      sessionIdForRequest: (threadId, turnId) => this.sessionIdForRequest(threadId, turnId)
    });
    if (!request) {
      return false;
    }

    this.pendingServerRequests.set(request.id, {
      rpcId: id,
      method,
      source: "server",
      request
    });
    this.debugLog?.write("server.request.queued", {
      requestId: request.id,
      method,
      sessionId: request.sessionId,
      threadId: request.threadId,
      turnId: request.turnId
    });
    this.emitBridgeEvent({
      type: "request.created",
      sessionId: request.sessionId,
      request
    });
    return true;
  }

  private markTurnFinished(turnId: string, status: "completed" | "interrupted" | "failed", message?: string) {
    this.activeTurnIds.delete(turnId);
    const mapping = this.runByTurn.get(turnId);
    this.debugLog?.write("turn.finished", {
      turnId,
      status,
      message: message ?? null,
      runId: mapping?.runId ?? null,
      sessionId: mapping?.sessionId ?? null,
      activeTurnCount: this.activeTurnIds.size
    });
  }

  private request(method: string, params: unknown) {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.debugLog?.write("request.send", {
        requestId: id,
        method,
        pendingRequests: this.pending.size + 1
      });
      this.pending.set(id, {
        resolve,
        reject,
        method
      });
      this.send({ id, method, params });
    });
  }

  private send(payload: Record<string, unknown>) {
    if (!this.child?.stdin.writable) {
      this.debugLog?.write("stdin.unwritable", {
        payload,
        pid: this.child?.pid ?? null
      });
      throw new Error("Codex app-server stdin is not writable");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private clearPendingServerRequests() {
    if (this.pendingServerRequests.size === 0) {
      return;
    }

    const requests = [...this.pendingServerRequests.values()];
    this.pendingServerRequests.clear();
    for (const entry of requests) {
      this.emitBridgeEvent({
        type: "request.resolved",
        sessionId: entry.request.sessionId,
        requestId: entry.request.id
      });
    }
  }

  private sessionIdForRequest(threadId: string, turnId: string | null) {
    if (turnId) {
      const mapping = this.runByTurn.get(turnId);
      if (mapping) {
        return mapping.sessionId;
      }
    }

    return this.sessionByThread.get(threadId) ?? threadId;
  }

  private turnSandboxPolicy(sandbox: StartRunParams["codex"] extends infer T
    ? T extends { sandbox?: infer S | null }
      ? S | null | undefined
      : never
    : never) {
    switch (sandbox ?? "workspace-write") {
      case "read-only":
        return { type: "readOnly" } as const;
      case "danger-full-access":
        return { type: "dangerFullAccess" } as const;
      case "workspace-write":
      default:
        return { type: "workspaceWrite" } as const;
    }
  }

  private async requestNewThread(cwd: string, codex?: StartRunParams["codex"]) {
    await this.ensureReady();
    this.debugLog?.write("thread.create.request", {
      cwd,
      approvalPolicy: codex?.approvalPolicy ?? "on-request",
      sandbox: codex?.sandbox ?? "workspace-write",
      serviceTier: codex?.serviceTier ?? null,
      model: codex?.model ?? null
    });
    const started = await this.request("thread/start", {
      cwd,
      approvalPolicy: codex?.approvalPolicy ?? "on-request",
      sandbox: codex?.sandbox ?? "workspace-write",
      ...(codex?.serviceTier ? { serviceTier: codex.serviceTier } : {}),
      ...(codex?.model ? { model: codex.model } : {}),
      serviceName: "codex_remote_web",
      experimentalRawEvents: false,
      persistExtendedHistory: true
    });
    const threadId = this.extractThreadId(started);
    if (!threadId) {
      throw new Error("Codex did not return a thread id");
    }
    this.debugLog?.write("thread.create.result", { cwd, threadId });
    return { threadId };
  }

  private pendingRequestFromSimulation(params: SimulatePendingRequestParams): CodexPendingRequest {
    const id = `dev_req_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const cwd = params.cwd;

    switch (params.scenario) {
      case "command_approval":
        return {
          type: "command_approval",
          id,
          sessionId: params.sessionId,
          threadId: params.threadId,
          turnId: null,
          itemId: null,
          createdAt,
          approvalId: null,
          reason: "Simulated command approval for UI verification.",
          networkApprovalContext: null,
          command: "npm test -- --runInBand",
          cwd,
          commandActions: [
            { type: "read", command: "cat package.json", name: "cat", path: `${cwd}/package.json` },
            { type: "search", command: "rg \"approvalPolicy\" apps", query: "approvalPolicy", path: `${cwd}/apps` }
          ],
          requestedPermissions: {
            network: { enabled: true },
            fileSystem: {
              read: [`${cwd}/package.json`, `${cwd}/apps`],
              write: [`${cwd}/tmp`]
            }
          },
          availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]
        };
      case "file_change_approval":
        return {
          type: "file_change_approval",
          id,
          sessionId: params.sessionId,
          threadId: params.threadId,
          turnId: null,
          itemId: null,
          createdAt,
          reason: "Simulated file change approval for UI verification.",
          grantRoot: cwd
        };
      case "permissions_approval":
        return {
          type: "permissions_approval",
          id,
          sessionId: params.sessionId,
          threadId: params.threadId,
          turnId: null,
          itemId: null,
          createdAt,
          reason: "Simulated additional permissions request for UI verification.",
          permissions: {
            network: { enabled: true },
            fileSystem: {
              read: [`${cwd}/docs`, `${cwd}/package.json`],
              write: [`${cwd}/apps/web/src`]
            }
          }
        };
      case "request_user_input":
        return {
          type: "request_user_input",
          id,
          sessionId: params.sessionId,
          threadId: params.threadId,
          turnId: null,
          itemId: null,
          createdAt,
          questions: [
            {
              id: "target_env",
              header: "Target env",
              question: "Which environment should Codex use?",
              isOther: false,
              isSecret: false,
              options: [
                { label: "staging", description: "Use staging configuration." },
                { label: "production", description: "Use production configuration." }
              ]
            },
            {
              id: "ticket",
              header: "Ticket",
              question: "What ticket or note should be included in the commit message?",
              isOther: false,
              isSecret: false,
              options: null
            }
          ]
        };
      case "mcp_elicitation":
        return {
          type: "mcp_elicitation",
          id,
          sessionId: params.sessionId,
          threadId: params.threadId,
          turnId: null,
          itemId: null,
          createdAt,
          mode: "form",
          serverName: "github",
          message: "Simulated MCP confirmation for UI verification.",
          meta: { requestId: id },
          requestedSchema: {
            type: "object",
            properties: {
              owner: { type: "string" },
              repo: { type: "string" }
            },
            required: ["owner", "repo"]
          }
        };
    }
  }

  private extractThreadId(result: unknown) {
    if (!result || typeof result !== "object") {
      return null;
    }
    const thread = (result as { thread?: { id?: string } }).thread;
    return typeof thread?.id === "string" ? thread.id : null;
  }

  private extractTurnId(result: unknown) {
    if (!result || typeof result !== "object") {
      return null;
    }
    const turn = (result as { turn?: { id?: string } }).turn;
    return typeof turn?.id === "string" ? turn.id : null;
  }

  private extractAccountRateLimits(result: unknown): CodexAccountRateLimits | null {
    if (!result || typeof result !== "object") {
      return null;
    }

    const payload = result as {
      rateLimits?: unknown;
      rateLimitsByLimitId?: unknown;
    };
    const rateLimits = this.extractRateLimitSnapshot(payload.rateLimits);
    if (!rateLimits) {
      return null;
    }

    return {
      rateLimits,
      rateLimitsByLimitId: this.extractRateLimitSnapshotMap(payload.rateLimitsByLimitId)
    };
  }

  private extractRateLimitSnapshotMap(value: unknown): Record<string, CodexRateLimitSnapshot> | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (!value || typeof value !== "object") {
      return null;
    }

    const entries = Object.entries(value).flatMap(([key, snapshot]) => {
      const normalized = this.extractRateLimitSnapshot(snapshot);
      return normalized ? ([[key, normalized]] as const) : [];
    });

    return Object.fromEntries(entries);
  }

  private extractRateLimitSnapshot(value: unknown): CodexRateLimitSnapshot | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    const snapshot = value as {
      limitId?: unknown;
      limitName?: unknown;
      primary?: unknown;
      secondary?: unknown;
      credits?: unknown;
      planType?: unknown;
    };

    return {
      limitId: typeof snapshot.limitId === "string" ? snapshot.limitId : null,
      limitName: typeof snapshot.limitName === "string" ? snapshot.limitName : null,
      primary: this.extractRateLimitWindow(snapshot.primary),
      secondary: this.extractRateLimitWindow(snapshot.secondary),
      credits: this.extractRateLimitCredits(snapshot.credits),
      planType: this.extractPlanType(snapshot.planType)
    };
  }

  private extractRateLimitWindow(value: unknown): CodexRateLimitWindow | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    const windowData = value as {
      usedPercent?: unknown;
      windowDurationMins?: unknown;
      resetsAt?: unknown;
    };
    const usedPercent = typeof windowData.usedPercent === "number" ? windowData.usedPercent : null;
    if (usedPercent === null) {
      return null;
    }

    return {
      usedPercent,
      windowDurationMins: typeof windowData.windowDurationMins === "number" ? windowData.windowDurationMins : null,
      resetsAt: typeof windowData.resetsAt === "number" ? windowData.resetsAt : null
    };
  }

  private extractRateLimitCredits(value: unknown): CodexRateLimitCredits | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    const credits = value as {
      hasCredits?: unknown;
      unlimited?: unknown;
      balance?: unknown;
    };

    return {
      hasCredits: Boolean(credits.hasCredits),
      unlimited: Boolean(credits.unlimited),
      balance: typeof credits.balance === "string" ? credits.balance : null
    };
  }

  private extractPlanType(value: unknown): CodexPlanType | null {
    const planTypes: CodexPlanType[] = [
      "free",
      "go",
      "plus",
      "pro",
      "team",
      "business",
      "enterprise",
      "edu",
      "unknown"
    ];

    return typeof value === "string" && planTypes.includes(value as CodexPlanType) ? (value as CodexPlanType) : null;
  }

  private extractModelListPage(result: unknown): { data: CodexAvailableModel[]; nextCursor: string | null } {
    const payload = asObject(result);
    const data = Array.isArray(payload?.data)
      ? payload.data.flatMap((entry) => {
          const model = this.extractAvailableModel(entry);
          return model ? [model] : [];
        })
      : [];

    return {
      data,
      nextCursor: typeof payload?.nextCursor === "string" ? payload.nextCursor : null
    };
  }

  private extractAvailableModel(value: unknown): CodexAvailableModel | null {
    const payload = asObject(value);
    const id = stringField(payload, "id");
    const model = stringField(payload, "model");
    const displayName = stringField(payload, "displayName");
    const description = stringField(payload, "description");
    const defaultReasoningEffort = this.extractReasoningEffort(payload?.defaultReasoningEffort);
    const inputModalities = this.extractInputModalities(payload?.inputModalities);

    if (!id || !model || !displayName || !description || !defaultReasoningEffort || inputModalities.length === 0) {
      return null;
    }

    const supportedReasoningEfforts = Array.isArray(payload?.supportedReasoningEfforts)
      ? payload.supportedReasoningEfforts.flatMap((entry) => {
          const option = this.extractReasoningEffortOption(entry);
          return option ? [option] : [];
        })
      : [];

    return {
      id,
      model,
      displayName,
      description,
      hidden: booleanField(payload, "hidden") ?? false,
      supportedReasoningEfforts,
      defaultReasoningEffort,
      inputModalities,
      supportsPersonality: booleanField(payload, "supportsPersonality") ?? false,
      isDefault: booleanField(payload, "isDefault") ?? false
    };
  }

  private extractReasoningEffortOption(value: unknown): CodexAvailableModel["supportedReasoningEfforts"][number] | null {
    const payload = asObject(value);
    const reasoningEffort = this.extractReasoningEffort(payload?.reasoningEffort);
    const description = stringField(payload, "description");
    if (!reasoningEffort || !description) {
      return null;
    }

    return {
      reasoningEffort,
      description
    };
  }

  private extractReasoningEffort(value: unknown): CodexReasoningEffort | null {
    const efforts: CodexReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
    return typeof value === "string" && efforts.includes(value as CodexReasoningEffort)
      ? (value as CodexReasoningEffort)
      : null;
  }

  private extractInputModalities(value: unknown): CodexAvailableModel["inputModalities"] {
    if (!Array.isArray(value)) {
      return ["text"];
    }

    const modalities = value.filter((entry): entry is CodexAvailableModel["inputModalities"][number] =>
      entry === "text" || entry === "image"
    );

    return modalities.length > 0 ? modalities : ["text"];
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function booleanField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}
