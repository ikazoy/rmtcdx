import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  CodexCommandAction,
  CodexCommandApprovalDecision,
  CodexPendingRequest,
  CodexPendingRequestResponse,
  CodexRequestUserInputOption,
  CodexRequestUserInputQuestion,
  JsonValue
} from "@codex-remote/shared-types";

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
  StartRunParams
} from "./types";
import type { CodexDebugLog } from "../observability/codex-debug-log";
import { parseBridgeNotification } from "./parsers/bridge-events";

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
  id: number | string;
  method: string;
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
    await this.ensureReady();
    this.debugLog?.write("thread.create.request", { cwd });
    const started = await this.request("thread/start", {
      cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
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

  async ensureThread(params: EnsureThreadParams) {
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
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
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

    const { threadId } = await this.createThread(params.cwd);

    if (params.sessionId) {
      this.sessionByThread.set(threadId, params.sessionId);
    }
    return { threadId };
  }

  async startRun(params: StartRunParams) {
    const ensured = await this.ensureThread({
      sessionId: params.sessionId,
      cwd: params.cwd,
      threadId: params.threadId
    });
    this.debugLog?.write("turn.start.request", {
      runId: params.runId,
      sessionId: params.sessionId ?? ensured.threadId,
      threadId: ensured.threadId,
      inputCount: params.input.length
    });
    const response = await this.request("turn/start", {
      threadId: ensured.threadId,
      input: params.input
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

    this.send({
      id: pending.id,
      result: this.resultForServerRequest(pending.request, response)
    });
    this.pendingServerRequests.delete(requestId);
    this.emitBridgeEvent({
      type: "request.resolved",
      sessionId: pending.request.sessionId,
      requestId
    });
    return pending.request;
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
    } catch (error) {
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
    const request = this.pendingRequestFromServerMessage(id, method, params);
    if (!request) {
      return false;
    }

    this.pendingServerRequests.set(request.id, {
      id,
      method,
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

  private pendingRequestFromServerMessage(
    requestId: number | string,
    method: string,
    params: unknown
  ): CodexPendingRequest | null {
    const payload = asObject(params);
    if (!payload) {
      return null;
    }

    const id = String(requestId);
    const createdAt = new Date().toISOString();

    if (method === "item/commandExecution/requestApproval") {
      const threadId = stringField(payload, "threadId");
      const turnId = stringField(payload, "turnId");
      if (!threadId || !turnId) {
        return null;
      }

      return {
        type: "command_approval",
        id,
        sessionId: this.sessionIdForRequest(threadId, turnId),
        threadId,
        turnId,
        itemId: stringField(payload, "itemId") ?? null,
        createdAt,
        approvalId: stringField(payload, "approvalId") ?? null,
        reason: stringField(payload, "reason") ?? null,
        networkApprovalContext: this.networkApprovalContext(payload.networkApprovalContext),
        command: stringField(payload, "command") ?? null,
        cwd: stringField(payload, "cwd") ?? null,
        commandActions: this.commandActions(payload.commandActions),
        requestedPermissions: this.requestedPermissions(payload.additionalPermissions),
        availableDecisions: this.commandApprovalDecisions(payload.availableDecisions)
      };
    }

    if (method === "item/fileChange/requestApproval") {
      const threadId = stringField(payload, "threadId");
      const turnId = stringField(payload, "turnId");
      if (!threadId || !turnId) {
        return null;
      }

      return {
        type: "file_change_approval",
        id,
        sessionId: this.sessionIdForRequest(threadId, turnId),
        threadId,
        turnId,
        itemId: stringField(payload, "itemId") ?? null,
        createdAt,
        reason: stringField(payload, "reason") ?? null,
        grantRoot: stringField(payload, "grantRoot") ?? null
      };
    }

    if (method === "item/permissions/requestApproval") {
      const threadId = stringField(payload, "threadId");
      const turnId = stringField(payload, "turnId");
      const permissions = this.requestedPermissions(payload.permissions);
      if (!threadId || !turnId || !permissions) {
        return null;
      }

      return {
        type: "permissions_approval",
        id,
        sessionId: this.sessionIdForRequest(threadId, turnId),
        threadId,
        turnId,
        itemId: stringField(payload, "itemId") ?? null,
        createdAt,
        reason: stringField(payload, "reason") ?? null,
        permissions
      };
    }

    if (method === "item/tool/requestUserInput") {
      const threadId = stringField(payload, "threadId");
      const turnId = stringField(payload, "turnId");
      if (!threadId || !turnId) {
        return null;
      }

      return {
        type: "request_user_input",
        id,
        sessionId: this.sessionIdForRequest(threadId, turnId),
        threadId,
        turnId,
        itemId: stringField(payload, "itemId") ?? null,
        createdAt,
        questions: this.requestUserInputQuestions(payload.questions)
      };
    }

    if (method === "mcpServer/elicitation/request") {
      const threadId = stringField(payload, "threadId");
      const serverName = stringField(payload, "serverName");
      const mode = stringField(payload, "mode");
      const message = stringField(payload, "message");
      if (!threadId || !serverName || !mode || !message) {
        return null;
      }

      const turnId = stringField(payload, "turnId") ?? null;
      const base = {
        type: "mcp_elicitation" as const,
        id,
        sessionId: this.sessionIdForRequest(threadId, turnId),
        threadId,
        turnId,
        itemId: null,
        createdAt,
        serverName,
        message,
        meta: this.jsonValue(payload._meta)
      };

      if (mode === "form") {
        return {
          ...base,
          mode,
          requestedSchema: this.jsonValue(payload.requestedSchema) ?? {}
        };
      }

      if (mode === "url") {
        const url = stringField(payload, "url");
        const elicitationId = stringField(payload, "elicitationId");
        if (!url || !elicitationId) {
          return null;
        }

        return {
          ...base,
          mode,
          url,
          elicitationId
        };
      }
    }

    return null;
  }

  private resultForServerRequest(request: CodexPendingRequest, response: CodexPendingRequestResponse) {
    if (request.type === "command_approval" && response.type === "command_approval") {
      return {
        decision: response.decision
      };
    }

    if (request.type === "file_change_approval" && response.type === "file_change_approval") {
      return {
        decision: response.decision
      };
    }

    if (request.type === "permissions_approval" && response.type === "permissions_approval") {
      return {
        permissions: response.permissions,
        scope: response.scope
      };
    }

    if (request.type === "request_user_input" && response.type === "request_user_input") {
      return {
        answers: response.answers
      };
    }

    if (request.type === "mcp_elicitation" && response.type === "mcp_elicitation") {
      return {
        action: response.action,
        content: response.content,
        _meta: response.meta ?? null
      };
    }

    throw new Error(`Unsupported Codex request response: ${request.type}`);
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

  private networkApprovalContext(value: unknown) {
    const payload = asObject(value);
    const host = stringField(payload, "host");
    const protocol = stringField(payload, "protocol");
    return host && protocol ? { host, protocol } : null;
  }

  private commandActions(value: unknown): CodexCommandAction[] | null {
    if (!Array.isArray(value)) {
      return null;
    }

    const actions: CodexCommandAction[] = [];
    for (const entry of value) {
      const payload = asObject(entry);
      if (!payload) {
        continue;
      }
      const type = stringField(payload, "type");
      const command = stringField(payload, "command");
      if (!type || !command) {
        continue;
      }

      if (type === "read") {
        const name = stringField(payload, "name");
        const path = stringField(payload, "path");
        if (name && path) {
          actions.push({ type, command, name, path });
        }
        continue;
      }

      if (type === "listFiles") {
        actions.push({ type, command, path: stringField(payload, "path") ?? null });
        continue;
      }

      if (type === "search") {
        actions.push({
          type,
          command,
          query: stringField(payload, "query") ?? null,
          path: stringField(payload, "path") ?? null
        });
        continue;
      }

      if (type === "unknown") {
        actions.push({ type, command });
      }
    }

    return actions.length > 0 ? actions : null;
  }

  private commandApprovalDecisions(value: unknown): CodexCommandApprovalDecision[] {
    if (!Array.isArray(value)) {
      return ["accept", "decline", "cancel"];
    }

    const decisions: CodexCommandApprovalDecision[] = [];
    for (const entry of value) {
      if (
        entry === "accept" ||
        entry === "acceptForSession" ||
        entry === "decline" ||
        entry === "cancel"
      ) {
        decisions.push(entry);
      }
    }

    return decisions.length > 0 ? decisions : ["accept", "decline", "cancel"];
  }

  private requestedPermissions(value: unknown) {
    const payload = asObject(value);
    if (!payload) {
      return null;
    }

    const fileSystem = asObject(payload.fileSystem);
    const network = asObject(payload.network);
    const read = stringArray(fileSystem?.read);
    const write = stringArray(fileSystem?.write);
    const enabled = booleanField(network, "enabled");
    const normalized = {
      fileSystem: read || write ? { read, write } : null,
      network: enabled !== undefined ? { enabled } : null
    };

    return normalized.fileSystem || normalized.network ? normalized : null;
  }

  private requestUserInputQuestions(value: unknown): CodexRequestUserInputQuestion[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const questions: CodexRequestUserInputQuestion[] = [];
    for (const entry of value) {
      const payload = asObject(entry);
      if (!payload) {
        continue;
      }
      const id = stringField(payload, "id");
      const header = stringField(payload, "header");
      const question = stringField(payload, "question");
      if (!id || !header || !question) {
        continue;
      }

      questions.push({
        id,
        header,
        question,
        isOther: booleanField(payload, "isOther") ?? false,
        isSecret: booleanField(payload, "isSecret") ?? false,
        options: this.requestUserInputOptions(payload.options)
      });
    }

    return questions;
  }

  private requestUserInputOptions(value: unknown): CodexRequestUserInputOption[] | null {
    if (!Array.isArray(value)) {
      return null;
    }

    const options: CodexRequestUserInputOption[] = [];
    for (const entry of value) {
      const payload = asObject(entry);
      if (!payload) {
        continue;
      }
      const label = stringField(payload, "label");
      const description = stringField(payload, "description");
      if (label && description) {
        options.push({ label, description });
      }
    }

    return options.length > 0 ? options : null;
  }

  private jsonValue(value: unknown): JsonValue | null {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      Array.isArray(value) ||
      (value && typeof value === "object")
    ) {
      return value as JsonValue;
    }

    return null;
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

function stringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }

  const items = value.filter((entry): entry is string => typeof entry === "string");
  return items.length > 0 ? items : null;
}
