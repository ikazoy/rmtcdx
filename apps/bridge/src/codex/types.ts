import { EventEmitter } from "node:events";
import type {
  CodexAvailableModel,
  CodexDevRequestScenario,
  CodexPendingRequest,
  CodexPendingRequestResponse,
  CodexRunSettings
} from "@codex-remote/shared-types";

export type CodexActivityKind = "command" | "tool" | "file" | "search" | "review";

export type CodexTextElement = {
  byteRange: {
    start: number;
    end: number;
  };
  placeholder: string | null;
};

export type CodexUserInput =
  | { type: "text"; text: string; text_elements: CodexTextElement[] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export type CodexThreadItem =
  | { type: "userMessage"; id: string; content: CodexUserInput[] }
  | { type: "agentMessage"; id: string; text: string; phase: string | null }
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      status: string;
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs?: number | null;
    }
  | {
      type: "fileChange";
      id: string;
      changes: Array<{
        path: string;
        kind: { type: "add" } | { type: "delete" } | { type: "update"; move_path: string | null };
        diff: string;
      }>;
      status: string;
    }
  | { type: "mcpToolCall"; id: string; server: string; tool: string; status: string }
  | { type: "dynamicToolCall"; id: string; tool: string; status: string }
  | { type: "collabAgentToolCall"; id: string; tool: string; status: string; prompt: string | null }
  | { type: "webSearch"; id: string; query: string }
  | { type: "imageView"; id: string; path: string }
  | { type: "imageGeneration"; id: string; status: string; revisedPrompt: string | null; result: string }
  | { type: "enteredReviewMode"; id: string; review: string }
  | { type: "exitedReviewMode"; id: string; review: string }
  | { type: "contextCompaction"; id: string }
  | { type: string; id: string };

export type CodexThreadTurn = {
  id: string;
  items: CodexThreadItem[];
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: { message: string | null } | null;
};

export type CodexThread = {
  id: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  status: { type: "notLoaded" | "idle" | "systemError" | "active"; activeFlags?: string[] };
  cwd: string;
  path: string | null;
  name: string | null;
  modelProvider: string;
  source: unknown;
  gitInfo: { sha: string | null; branch: string | null; originUrl: string | null } | null;
  turns: CodexThreadTurn[];
};

export type ListThreadsParams = {
  cwd?: string;
  archived?: boolean;
  searchTerm?: string;
  limit?: number;
};

export type CodexRuntimeState = {
  mode: "real" | "mock";
  ready: boolean;
  childAlive: boolean;
  restarts: number;
  lastError?: string;
};

export type CodexRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type CodexRateLimitCredits = {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
};

export type CodexPlanType = "free" | "go" | "plus" | "pro" | "team" | "business" | "enterprise" | "edu" | "unknown";

export type CodexRateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: CodexRateLimitCredits | null;
  planType: CodexPlanType | null;
};

export type CodexAccountRateLimits = {
  rateLimits: CodexRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot> | null;
};

export type CodexBridgeItemDelta =
  | { kind: "agentMessage.text" }
  | { kind: "plan.text" }
  | { kind: "reasoning.summaryText"; summaryIndex: number }
  | { kind: "reasoning.text"; contentIndex: number }
  | { kind: "commandExecution.output" }
  | { kind: "fileChange.output" };

export type CodexBridgeEvent =
  | { type: "item.started"; sessionId: string; runId: string; turnId: string; item: CodexThreadItem }
  | ({
      type: "item.delta";
      sessionId: string;
      runId: string;
      turnId: string;
      itemId: string;
      delta: string;
    } & CodexBridgeItemDelta)
  | { type: "item.completed"; sessionId: string; runId: string; turnId: string; item: CodexThreadItem }
  | {
      type: "activity.started";
      sessionId: string;
      runId: string;
      turnId: string;
      itemId: string;
      kind: CodexActivityKind;
      label: string;
    }
  | {
      type: "activity.updated";
      sessionId: string;
      runId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "activity.completed";
      sessionId: string;
      runId: string;
      turnId: string;
      itemId: string;
    }
  | { type: "tool.start"; sessionId: string; runId: string; turnId: string; name: string }
  | { type: "tool.end"; sessionId: string; runId: string; turnId: string; name: string; ok: boolean }
  | { type: "run.completed"; sessionId: string; runId: string; turnId: string }
  | { type: "run.interrupted"; sessionId: string; runId: string; turnId: string }
  | { type: "run.error"; sessionId: string; runId: string; turnId: string; message: string }
  | { type: "request.created"; sessionId: string; request: CodexPendingRequest }
  | { type: "request.resolved"; sessionId: string; requestId: string }
  | { type: "backend.degraded"; reason: string };

export type EnsureThreadParams = {
  sessionId?: string;
  cwd: string;
  threadId?: string;
  path?: string;
};

export type StartRunParams = {
  sessionId?: string;
  runId: string;
  cwd: string;
  input: CodexUserInput[];
  threadId?: string;
  codex?: CodexRunSettings;
};

export type SimulatePendingRequestParams = {
  sessionId: string;
  threadId: string;
  cwd: string;
  scenario: CodexDevRequestScenario;
};

export type StartRunResult = {
  threadId: string;
  turnId: string;
};

export type CodexFileReadResult = {
  dataBase64: string;
};

export type CodexFileMetadata = {
  isDirectory: boolean;
  isFile: boolean;
  createdAtMs: number | null;
  modifiedAtMs: number | null;
  sizeBytes?: number | null;
};

export interface CodexBackend extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  createThread(cwd: string): Promise<{ threadId: string }>;
  listThreads(params?: ListThreadsParams): Promise<CodexThread[]>;
  readThread(threadId: string, options?: { includeTurns?: boolean }): Promise<CodexThread>;
  listModels(): Promise<CodexAvailableModel[]>;
  readAccountRateLimits(): Promise<CodexAccountRateLimits | null>;
  readFile(path: string): Promise<CodexFileReadResult>;
  getFileMetadata(path: string): Promise<CodexFileMetadata>;
  setThreadName(threadId: string, name: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  unarchiveThread(threadId: string): Promise<void>;
  ensureThread(params: EnsureThreadParams): Promise<{ threadId: string }>;
  startRun(params: StartRunParams): Promise<StartRunResult>;
  interruptRun(runId: string, threadId: string, turnId: string): Promise<void>;
  listPendingRequests(sessionId?: string): CodexPendingRequest[];
  respondToRequest(requestId: string, response: CodexPendingRequestResponse): Promise<CodexPendingRequest | null>;
  simulatePendingRequest(params: SimulatePendingRequestParams): Promise<CodexPendingRequest>;
  getState(): CodexRuntimeState;
}

export type LoggerLike = Pick<Console, "info" | "warn" | "error" | "debug">;
