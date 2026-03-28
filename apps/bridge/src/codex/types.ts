import { EventEmitter } from "node:events";

export type CodexRuntimeState = {
  mode: "real" | "mock";
  ready: boolean;
  childAlive: boolean;
  restarts: number;
  lastError?: string;
};

export type CodexBridgeEvent =
  | { type: "message.delta"; sessionId: string; runId: string; turnId: string; text: string }
  | { type: "message.final"; sessionId: string; runId: string; turnId: string; text: string; countsUnread: boolean }
  | { type: "tool.start"; sessionId: string; runId: string; turnId: string; name: string }
  | { type: "tool.end"; sessionId: string; runId: string; turnId: string; name: string; ok: boolean }
  | { type: "run.completed"; sessionId: string; runId: string; turnId: string }
  | { type: "run.interrupted"; sessionId: string; runId: string; turnId: string }
  | { type: "run.error"; sessionId: string; runId: string; turnId: string; message: string }
  | { type: "backend.degraded"; reason: string };

export type EnsureThreadParams = {
  sessionId: string;
  cwd: string;
  threadId?: string;
};

export type StartRunParams = {
  sessionId: string;
  runId: string;
  cwd: string;
  prompt: string;
  threadId?: string;
};

export type StartRunResult = {
  threadId: string;
  turnId: string;
};

export interface CodexBackend extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  ensureThread(params: EnsureThreadParams): Promise<{ threadId: string }>;
  startRun(params: StartRunParams): Promise<StartRunResult>;
  interruptRun(runId: string, threadId: string, turnId: string): Promise<void>;
  getState(): CodexRuntimeState;
}

export type LoggerLike = Pick<Console, "info" | "warn" | "error" | "debug">;
