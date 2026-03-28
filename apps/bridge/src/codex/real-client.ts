import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { CodexBackend, CodexBridgeEvent, CodexRuntimeState, EnsureThreadParams, LoggerLike, StartRunParams } from "./types";

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
  private restarting = false;
  private stopped = false;
  private ready = false;
  private restarts = 0;
  private lastError: string | undefined;

  constructor(private readonly logger: LoggerLike) {
    super();
  }

  async start() {
    if (this.ready && this.child) {
      return;
    }

    this.stopped = false;
    this.spawnChild();
    await this.initialize();
  }

  async stop() {
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
  }

  async ensureThread(params: EnsureThreadParams) {
    await this.ensureReady();
    if (params.threadId) {
      const resumed = await this.request("thread/resume", {
        threadId: params.threadId,
        cwd: params.cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        persistExtendedHistory: true
      });
      this.sessionByThread.set(params.threadId, params.sessionId);
      return { threadId: this.extractThreadId(resumed) ?? params.threadId };
    }

    const started = await this.request("thread/start", {
      cwd: params.cwd,
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

    this.sessionByThread.set(threadId, params.sessionId);
    return { threadId };
  }

  async startRun(params: StartRunParams) {
    const ensured = await this.ensureThread({
      sessionId: params.sessionId,
      cwd: params.cwd,
      threadId: params.threadId
    });
    const response = await this.request("turn/start", {
      threadId: ensured.threadId,
      input: [{ type: "text", text: params.prompt, text_elements: [] }]
    });

    const turnId = this.extractTurnId(response);
    if (!turnId) {
      throw new Error("Codex did not return a turn id");
    }

    this.sessionByThread.set(ensured.threadId, params.sessionId);
    this.runByTurn.set(turnId, {
      sessionId: params.sessionId,
      runId: params.runId
    });

    return {
      threadId: ensured.threadId,
      turnId
    };
  }

  async interruptRun(runId: string, _threadId: string, turnId: string) {
    await this.ensureReady();
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
    this.child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.buffer = "";

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
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

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) {
        this.logger.warn(text);
      }
    });

    this.child.on("exit", (code, signal) => {
      this.ready = false;
      this.child = null;
      this.lastError = `codex app-server exited (${code ?? "null"} / ${signal ?? "null"})`;
      if (!this.stopped && !this.restarting) {
        this.restarts += 1;
        this.restarting = true;
        this.emitBridgeEvent({
          type: "backend.degraded",
          reason: this.lastError
        });
        setTimeout(() => {
          this.restarting = false;
          void this.start().catch((error: Error) => {
            this.lastError = error.message;
            this.logger.error(error.message);
          });
        }, 700);
      }
    });
  }

  private async initialize() {
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
  }

  private handleLine(line: string) {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
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
        pending.reject(new Error(message.error.message ?? `Codex request failed: ${pending.method}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
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

    if (method === "item/started") {
      const payload = params as { turnId: string; item?: { type?: string; tool?: string; server?: string; command?: string } };
      const mapping = this.runByTurn.get(payload.turnId);
      if (!mapping || !payload.item) {
        return;
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
        this.emitBridgeEvent({
          type: "run.completed",
          sessionId: mapping.sessionId,
          runId: mapping.runId,
          turnId
        });
      } else if (payload.turn?.status === "interrupted") {
        this.emitBridgeEvent({
          type: "run.interrupted",
          sessionId: mapping.sessionId,
          runId: mapping.runId,
          turnId
        });
      } else {
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

  private emitBridgeEvent(event: CodexBridgeEvent) {
    this.emit("event", event);
  }

  private request(method: string, params: unknown) {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
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
}
