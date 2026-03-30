import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

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

export class RealCodexClient extends EventEmitter implements CodexBackend {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
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
      approvalPolicy: "never",
      sandbox: "danger-full-access",
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
        approvalPolicy: "never",
        sandbox: "danger-full-access",
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
    if (!params || typeof params !== "object") {
      return;
    }

    if (method === "item/agentMessage/delta") {
      const payload = params as { threadId: string; turnId: string; delta: string };
      const mapping = this.runByTurn.get(payload.turnId);
      if (!mapping) {
        return;
      }
      this.emitBridgeEvent({
        type: "message.delta",
        sessionId: mapping.sessionId,
        runId: mapping.runId,
        turnId: payload.turnId,
        text: payload.delta
      });
      return;
    }

    if (method === "item/commandExecution/outputDelta") {
      const payload = params as { threadId: string; turnId: string; itemId: string; delta: string };
      const mapping = this.runByTurn.get(payload.turnId);
      if (!mapping) {
        return;
      }
      this.emitBridgeEvent({
        type: "activity.updated",
        sessionId: mapping.sessionId,
        runId: mapping.runId,
        turnId: payload.turnId,
        itemId: payload.itemId,
        delta: payload.delta
      });
      return;
    }

    if (method === "item/started") {
      const payload = params as {
        turnId: string;
        item?: { id?: string; type?: string; tool?: string; server?: string; command?: string };
      };
      const mapping = this.runByTurn.get(payload.turnId);
      if (!mapping || !payload.item) {
        return;
      }
      const activity = this.activityFromItem(payload.item);
      if (activity && payload.item.id) {
        this.emitBridgeEvent({
          type: "activity.started",
          sessionId: mapping.sessionId,
          runId: mapping.runId,
          turnId: payload.turnId,
          itemId: payload.item.id,
          kind: activity.kind,
          label: activity.label
        });
      }
      const toolName = this.toolName(payload.item);
      if (!toolName) {
        return;
      }
      this.emitBridgeEvent({
        type: "tool.start",
        sessionId: mapping.sessionId,
        runId: mapping.runId,
        turnId: payload.turnId,
        name: toolName
      });
      return;
    }

    if (method === "item/completed") {
      const payload = params as {
        turnId: string;
        item?: {
          id?: string;
          type?: string;
          text?: string;
          phase?: string | null;
          status?: string;
          tool?: string;
          server?: string;
          command?: string;
        };
      };
      const mapping = this.runByTurn.get(payload.turnId);
      if (!mapping || !payload.item) {
        return;
      }

      if (payload.item.type === "agentMessage" && payload.item.text) {
        const countsUnread = payload.item.phase !== "commentary";
        this.emitBridgeEvent({
          type: "message.final",
          sessionId: mapping.sessionId,
          runId: mapping.runId,
          turnId: payload.turnId,
          text: payload.item.text,
          countsUnread
        });
        return;
      }

      if (payload.item.id) {
        const activity = this.activityFromItem(payload.item);
        if (activity) {
          this.emitBridgeEvent({
            type: "activity.completed",
            sessionId: mapping.sessionId,
            runId: mapping.runId,
            turnId: payload.turnId,
            itemId: payload.item.id
          });
        }
      }

      const toolName = this.toolName(payload.item);
      if (!toolName) {
        return;
      }

      const ok = !payload.item.status || !["failed", "declined"].includes(payload.item.status);
      this.emitBridgeEvent({
        type: "tool.end",
        sessionId: mapping.sessionId,
        runId: mapping.runId,
        turnId: payload.turnId,
        name: toolName,
        ok
      });
      return;
    }

    if (method === "turn/completed") {
      const payload = params as {
        turnId?: string;
        turn?: {
          id: string;
          status: "completed" | "interrupted" | "failed" | "inProgress";
          error?: { message?: string } | null;
        };
      };
      const turnId = payload.turn?.id ?? payload.turnId;
      if (!turnId) {
        return;
      }
      const mapping = this.runByTurn.get(turnId);
      if (!mapping) {
        return;
      }

      if (payload.turn?.status === "completed") {
        this.markTurnFinished(turnId, "completed");
        this.emitBridgeEvent({
          type: "run.completed",
          sessionId: mapping.sessionId,
          runId: mapping.runId,
          turnId
        });
      } else if (payload.turn?.status === "interrupted") {
        this.markTurnFinished(turnId, "interrupted");
        this.emitBridgeEvent({
          type: "run.interrupted",
          sessionId: mapping.sessionId,
          runId: mapping.runId,
          turnId
        });
      } else {
        this.markTurnFinished(turnId, "failed", payload.turn?.error?.message ?? "Codex turn failed");
        this.emitBridgeEvent({
          type: "run.error",
          sessionId: mapping.sessionId,
          runId: mapping.runId,
          turnId,
          message: payload.turn?.error?.message ?? "Codex turn failed"
        });
      }
      return;
    }

    if (method === "error") {
      const payload = params as { threadId?: string; turnId?: string; error?: { message?: string } };
      if (!payload.turnId) {
        this.debugLog?.write("backend.error", {
          threadId: payload.threadId ?? null,
          message: payload.error?.message ?? "Codex backend error"
        });
        this.emitBridgeEvent({
          type: "backend.degraded",
          reason: payload.error?.message ?? "Codex backend error"
        });
        return;
      }
      const mapping = this.runByTurn.get(payload.turnId);
      if (!mapping) {
        return;
      }
      this.markTurnFinished(payload.turnId, "failed", payload.error?.message ?? "Codex backend error");
      this.emitBridgeEvent({
        type: "run.error",
        sessionId: mapping.sessionId,
        runId: mapping.runId,
        turnId: payload.turnId,
        message: payload.error?.message ?? "Codex backend error"
      });
    }
  }

  private toolName(item: { type?: string; tool?: string; server?: string; command?: string }) {
    if (!item.type) {
      return null;
    }
    if (item.type === "commandExecution") {
      return item.command ? `shell:${item.command.split(" ")[0]}` : "shell";
    }
    if (item.type === "mcpToolCall") {
      return item.server && item.tool ? `${item.server}:${item.tool}` : item.tool ?? "mcp";
    }
    if (item.type === "dynamicToolCall") {
      return item.tool ?? "tool";
    }
    if (item.type === "fileChange") {
      return "apply_patch";
    }
    if (item.type === "webSearch") {
      return "web_search";
    }
    if (item.type === "collabAgentToolCall") {
      return item.tool ?? "agent";
    }
    return null;
  }

  private activityFromItem(item: {
    type?: string;
    tool?: string;
    server?: string;
    command?: string;
  }) {
    if (!item.type) {
      return null;
    }
    if (item.type === "commandExecution") {
      return {
        kind: "command" as const,
        label: item.command ?? "shell command"
      };
    }
    if (item.type === "mcpToolCall" || item.type === "dynamicToolCall" || item.type === "collabAgentToolCall") {
      return {
        kind: "tool" as const,
        label: item.server && item.tool ? `${item.server}:${item.tool}` : item.tool ?? "tool"
      };
    }
    if (item.type === "fileChange") {
      return {
        kind: "file" as const,
        label: "Applying file changes"
      };
    }
    if (item.type === "webSearch") {
      return {
        kind: "search" as const,
        label: "Running web search"
      };
    }
    if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
      return {
        kind: "review" as const,
        label: "Review mode"
      };
    }
    return null;
  }

  private emitBridgeEvent(event: CodexBridgeEvent) {
    this.emit("event", event);
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
