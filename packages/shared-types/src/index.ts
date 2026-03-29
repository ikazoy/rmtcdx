export type SessionStatus = "idle" | "running" | "completed" | "error" | "archived";
export type RunStatus = "queued" | "running" | "completed" | "interrupted" | "error";
export type MessageRole = "user" | "assistant" | "system";
export type MessageKind =
  | "user_message"
  | "assistant_message"
  | "assistant_thinking"
  | "plan"
  | "reasoning"
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "collab_agent_tool_call"
  | "web_search"
  | "image_view"
  | "image_generation"
  | "review_mode_entered"
  | "review_mode_exited"
  | "context_compaction"
  | "run_error";

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
  repoName?: string;
  title: string;
  summary: string;
  codexThreadId?: string;
  status: SessionStatus;
  unreadCount: number;
  lastEventSeq: number;
  lastReadEventSeq: number;
  lastMessageAt: string;
  lastUserMessageAt?: string;
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
  attachments?: MessageAttachment[];
  createdAt: string;
  kind: MessageKind;
  status?: string;
  metadata?: MessageMetadata;
};

export type MessageAttachment = {
  kind: "image";
  name: string;
  url: string;
};

export type MessageMetadata =
  | {
      type: "command_execution";
      command: string;
      cwd: string;
      output: string | null;
      exitCode: number | null;
      durationMs?: number | null;
    }
  | {
      type: "file_change";
      changes: FileChangeEntry[];
    };

export type FileChangeEntry = {
  path: string;
  kind: "add" | "delete" | "update";
  movePath?: string | null;
  diff?: string;
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

export type LiveActivityKind = "command" | "tool" | "file" | "search" | "review";

export type LiveActivity = {
  sessionId: string;
  runId: string;
  turnId: string;
  itemId: string;
  kind: LiveActivityKind;
  label: string;
  output: string;
  startedAt: string;
  updatedAt: string;
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
  prompt: string;
  sessionId?: string;
  repoId?: string;
  attachments?: ImageAttachmentInput[];
};

export type ImageAttachmentInput = {
  name: string;
  mimeType: string;
  dataUrl: string;
  size: number;
};

export type UpdateSessionRequest = {
  title: string;
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
  | { type: "activity.started"; activity: LiveActivity }
  | { type: "activity.updated"; sessionId: string; itemId: string; delta: string; updatedAt: string }
  | { type: "activity.completed"; sessionId: string; itemId: string }
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
