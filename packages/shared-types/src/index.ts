export type SessionStatus = "idle" | "running" | "completed" | "error" | "archived";
export type RunStatus = "queued" | "running" | "completed" | "interrupted" | "error";
export type MessageRole = "user" | "assistant" | "system";

export type Repository = {
  id: string;
  name: string;
  path: string;
  description?: string;
  branch?: string;
  pinned: boolean;
  runningSessionCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SessionSummary = {
  id: string;
  repoId: string;
  title: string;
  summary: string;
  codexThreadId?: string;
  status: SessionStatus;
  unreadCount: number;
  lastEventSeq: number;
  lastReadEventSeq: number;
  lastMessageAt: string;
  lastRunFinishedAt?: string;
  latestUserPrompt?: string;
  latestAssistantExcerpt?: string;
  hasUnreadCompletion: boolean;
  hasUnreadError: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  sessionId: string;
  role: MessageRole;
  text: string;
  createdAt: string;
};

export type Run = {
  id: string;
  sessionId: string;
  turnId?: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  errorMessage?: string;
};

export type SessionDetail = {
  session: SessionSummary;
  activeRun: Run | null;
  latestRun: Run | null;
};

export type HealthResponse = {
  ok: boolean;
  dbOk: boolean;
  codex: {
    mode: "real" | "mock";
    ready: boolean;
    childAlive: boolean;
    restarts: number;
    lastError?: string;
  };
  metrics: {
    activeWebSockets: number;
    activeRuns: number;
  };
};

export type ReposResponse = { repos: Repository[] };
export type SessionsResponse = { sessions: SessionSummary[] };
export type SessionResponse = SessionDetail;
export type MessagesResponse = { messages: Message[] };
export type RunResponse = { run: Run };

export type CreateSessionRequest = {
  repoId: string;
  title?: string;
};

export type CreateRunRequest = {
  sessionId: string;
  prompt: string;
};

export type ClientWsEvent =
  | { type: "ping" }
  | { type: "session.read"; sessionId: string };

export type ServerWsEvent =
  | { type: "hello"; mode: "real" | "mock" }
  | { type: "pong"; ts: string }
  | { type: "repos.updated"; repos: Repository[] }
  | { type: "sessions.updated"; session: SessionSummary }
  | { type: "session.updated"; detail: SessionDetail }
  | { type: "run.started"; run: Run }
  | { type: "run.completed"; run: Run }
  | { type: "run.error"; run: Run }
  | { type: "run.interrupted"; run: Run }
  | { type: "message.delta"; sessionId: string; runId: string; text: string }
  | { type: "message.final"; sessionId: string; runId: string; message: Message }
  | {
      type: "notification.unread";
      sessionId: string;
      unreadCount: number;
      hasUnreadCompletion: boolean;
      hasUnreadError: boolean;
    }
  | { type: "backend.degraded"; reason: string };

export const SESSION_FILTERS = ["all", "running", "unread", "completed", "error"] as const;
export type SessionFilter = (typeof SESSION_FILTERS)[number];
