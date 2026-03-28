import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type { CodexBackend, CodexRuntimeState, EnsureThreadParams, LoggerLike, StartRunParams } from "./types";

type MockRunHandle = {
  timers: NodeJS.Timeout[];
  sessionId: string;
  runId: string;
  turnId: string;
};

export class MockCodexClient extends EventEmitter implements CodexBackend {
  private readonly runs = new Map<string, MockRunHandle>();

  constructor(private readonly logger: LoggerLike) {
    super();
  }

  async start() {
    this.logger.info("Mock Codex backend ready");
  }

  async stop() {
    for (const run of this.runs.values()) {
      run.timers.forEach((timer) => clearTimeout(timer));
    }
    this.runs.clear();
  }

  async ensureThread(_params: EnsureThreadParams) {
    return { threadId: `mock_thread_${randomUUID()}` };
  }

  async startRun(params: StartRunParams) {
    const threadId = params.threadId ?? `mock_thread_${randomUUID()}`;
    const turnId = `mock_turn_${randomUUID()}`;
    const chunks = [
      "Planning the changes against the selected repository.\n",
      "Scanning current files and deriving the first implementation pass.\n",
      "Applying the main update now.\n"
    ];

    const timers = chunks.map((chunk, index) =>
      setTimeout(() => {
        this.emit("event", {
          type: "message.delta",
          sessionId: params.sessionId,
          runId: params.runId,
          turnId,
          text: chunk
        });
      }, 500 + index * 700)
    );

    timers.push(
      setTimeout(() => {
        const text = [
          `Mock run completed for prompt: ${params.prompt}`,
          "",
          "This is a fallback response from the local mock backend.",
          "Switch CODEX_MODE=real to force Codex app-server usage."
        ].join("\n");

        this.emit("event", {
          type: "message.final",
          sessionId: params.sessionId,
          runId: params.runId,
          turnId,
          text,
          countsUnread: true
        });
        this.emit("event", {
          type: "run.completed",
          sessionId: params.sessionId,
          runId: params.runId,
          turnId
        });
        this.runs.delete(params.runId);
      }, 2900)
    );

    this.runs.set(params.runId, {
      sessionId: params.sessionId,
      runId: params.runId,
      turnId,
      timers
    });

    return { threadId, turnId };
  }

  async interruptRun(runId: string) {
    const handle = this.runs.get(runId);
    if (!handle) {
      return;
    }

    handle.timers.forEach((timer) => clearTimeout(timer));
    this.runs.delete(runId);
    this.emit("event", {
      type: "run.interrupted",
      sessionId: handle.sessionId,
      runId: handle.runId,
      turnId: handle.turnId
    });
  }

  getState(): CodexRuntimeState {
    return {
      mode: "mock",
      ready: true,
      childAlive: false,
      restarts: 0
    };
  }
}
