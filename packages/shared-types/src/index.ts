export type SessionStatus = "idle" | "running" | "completed" | "interrupted" | "error" | "archived";
export type RunStatus = "queued" | "running" | "completed" | "interrupted" | "error";
export type CodexTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type CodexThreadStatusType = "notLoaded" | "idle" | "systemError" | "active";
export type SessionStatusReasonCode =
  | "thread_active"
  | "thread_system_error"
  | "latest_turn_completed"
  | "latest_turn_interrupted"
  | "latest_turn_failed"
  | "in_progress_but_thread_inactive"
  | "empty_thread"
  | "history_present"
  | "local_active_run"
  | "local_latest_run_queued"
  | "local_latest_run_running"
  | "local_latest_run_completed"
  | "local_latest_run_interrupted"
  | "local_latest_run_error";
export type SessionStatusConfidence = "authoritative" | "derived" | "suspicious";
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
  isArchived: boolean;
  unreadCount: number;
  lastEventSeq: number;
  lastReadEventSeq: number;
  lastMessageAt: string;
  lastUserMessageAt?: string;
  lastRunFinishedAt?: string;
  statusReasonCode?: SessionStatusReasonCode;
  statusConfidence?: SessionStatusConfidence;
  latestTurnStatus?: CodexTurnStatus | null;
  threadStatusType?: CodexThreadStatusType;
  latestUserPrompt?: string;
  latestAssistantExcerpt?: string;
  pendingRequestCount: number;
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
    }
  | {
      type: "web_search";
      query: string;
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

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type CodexCommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path: string | null }
  | { type: "search"; command: string; query: string | null; path: string | null }
  | { type: "unknown"; command: string };

export type CodexAdditionalFileSystemPermissions = {
  read: string[] | null;
  write: string[] | null;
};

export type CodexAdditionalNetworkPermissions = {
  enabled: boolean | null;
};

export type CodexRequestedPermissionProfile = {
  network: CodexAdditionalNetworkPermissions | null;
  fileSystem: CodexAdditionalFileSystemPermissions | null;
};

export type CodexGrantedPermissionProfile = {
  network?: CodexAdditionalNetworkPermissions;
  fileSystem?: CodexAdditionalFileSystemPermissions;
};

export type CodexNetworkApprovalContext = {
  host: string;
  protocol: string;
};

export type CodexCommandApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type CodexFileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type CodexPermissionGrantScope = "turn" | "session";
export type CodexMcpElicitationAction = "accept" | "decline" | "cancel";
export type CodexApprovalPolicyPreset = "untrusted" | "on-failure" | "on-request" | "never";
export type CodexSandboxPreset = "read-only" | "workspace-write" | "danger-full-access";
export type CodexServiceTier = "fast" | "flex";
export type CodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type CodexInputModality = "text" | "image";

export type CodexRunSettings = {
  approvalPolicy?: CodexApprovalPolicyPreset | null;
  sandbox?: CodexSandboxPreset | null;
  serviceTier?: CodexServiceTier | null;
  model?: string | null;
};

export type CodexReasoningEffortOption = {
  reasoningEffort: CodexReasoningEffort;
  description: string;
};

export type CodexAvailableModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  defaultReasoningEffort: CodexReasoningEffort;
  inputModalities: CodexInputModality[];
  supportsPersonality: boolean;
  isDefault: boolean;
};

export type CodexRequestUserInputOption = {
  label: string;
  description: string;
};

export type CodexRequestUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: CodexRequestUserInputOption[] | null;
};

export type CodexRequestUserInputAnswer = {
  answers: string[];
};

type CodexPendingRequestBase = {
  id: string;
  sessionId: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  createdAt: string;
};

export type CodexCommandApprovalRequest = CodexPendingRequestBase & {
  type: "command_approval";
  approvalId: string | null;
  reason: string | null;
  networkApprovalContext: CodexNetworkApprovalContext | null;
  command: string | null;
  cwd: string | null;
  commandActions: CodexCommandAction[] | null;
  requestedPermissions: CodexRequestedPermissionProfile | null;
  availableDecisions: CodexCommandApprovalDecision[];
};

export type CodexFileChangeApprovalRequest = CodexPendingRequestBase & {
  type: "file_change_approval";
  reason: string | null;
  grantRoot: string | null;
};

export type CodexPermissionsApprovalRequest = CodexPendingRequestBase & {
  type: "permissions_approval";
  reason: string | null;
  permissions: CodexRequestedPermissionProfile;
};

export type CodexRequestUserInputRequest = CodexPendingRequestBase & {
  type: "request_user_input";
  questions: CodexRequestUserInputQuestion[];
};

export type CodexMcpElicitationRequest = CodexPendingRequestBase &
  (
    | {
        type: "mcp_elicitation";
        mode: "form";
        serverName: string;
        message: string;
        meta: JsonValue | null;
        requestedSchema: JsonValue;
      }
    | {
        type: "mcp_elicitation";
        mode: "url";
        serverName: string;
        message: string;
        meta: JsonValue | null;
        url: string;
        elicitationId: string;
      }
  );

export type CodexPendingRequest =
  | CodexCommandApprovalRequest
  | CodexFileChangeApprovalRequest
  | CodexPermissionsApprovalRequest
  | CodexRequestUserInputRequest
  | CodexMcpElicitationRequest;

export type CodexPendingRequestResponse =
  | { type: "command_approval"; decision: CodexCommandApprovalDecision }
  | { type: "file_change_approval"; decision: CodexFileChangeApprovalDecision }
  | { type: "permissions_approval"; permissions: CodexGrantedPermissionProfile; scope: CodexPermissionGrantScope }
  | { type: "request_user_input"; answers: Record<string, CodexRequestUserInputAnswer> }
  | { type: "mcp_elicitation"; action: CodexMcpElicitationAction; content: JsonValue | null; meta?: JsonValue | null };

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
  runSettings: CodexRunSettings | null;
};

export type HealthResponse = {
  ok: boolean;
  stateOk: boolean;
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
  devTools: {
    codexRequestSimulator: boolean;
  };
};

export type ReposResponse = { repos: Repository[] };
export type SessionsResponse = { sessions: SessionSummary[] };
export type SessionResponse = SessionDetail;
export type MessagesResponse = { messages: Message[] };
export type RunResponse = { run: Run };
export type CodexModelsResponse = { models: CodexAvailableModel[] };
export type PendingCodexRequestsResponse = { requests: CodexPendingRequest[] };
export type SessionFilePreviewRequest = {
  path: string;
  diff?: string | null;
  changeKind?: FileChangeEntry["kind"] | null;
  movePath?: string | null;
};
export type SessionFilePreviewContentStatus = "ok" | "missing" | "directory" | "binary" | "too_large";
export type SessionFilePreviewResponse = {
  path: string;
  resolvedPath: string | null;
  contentStatus: SessionFilePreviewContentStatus;
  mediaType: string | null;
  sizeBytes: number | null;
  isMarkdown: boolean;
  text: string | null;
  imageDataUrl: string | null;
  diff: string | null;
  changeKind: FileChangeEntry["kind"] | null;
  movePath: string | null;
};

export type CreateSessionRequest = {
  repoId: string;
  title?: string;
};

export type CreateRunRequest = {
  prompt: string;
  sessionId?: string;
  repoId?: string;
  attachments?: ImageAttachmentInput[];
  codex?: CodexRunSettings;
};

export type CodexDevRequestScenario =
  | "command_approval"
  | "file_change_approval"
  | "permissions_approval"
  | "request_user_input"
  | "mcp_elicitation";

export type SimulateCodexRequestRequest = {
  scenario: CodexDevRequestScenario;
};

export type SimulateCodexRequestResponse = {
  request: CodexPendingRequest;
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

export type NotificationsConfigResponse = {
  notifications: {
    available: boolean;
    vapidPublicKey: string | null;
  };
};

export type SavePushSubscriptionRequest = {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string;
  platform?: string;
};

export type DeletePushSubscriptionRequest = {
  endpoint: string;
};

export type AccountPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "team"
  | "business"
  | "enterprise"
  | "edu"
  | "unknown";

export type AccountRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: string | null;
};

export type AccountRateLimitCredits = {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
};

export type AccountRateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: AccountRateLimitWindow | null;
  secondary: AccountRateLimitWindow | null;
  credits: AccountRateLimitCredits | null;
  planType: AccountPlanType | null;
};

export type AccountRateLimits = {
  rateLimits: AccountRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, AccountRateLimitSnapshot> | null;
  fetchedAt: string;
};

export type AccountRateLimitsResponse = {
  available: boolean;
  rateLimits: AccountRateLimits | null;
  error: string | null;
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
  | { type: "codex.request.created"; sessionId: string; request: CodexPendingRequest }
  | { type: "codex.request.resolved"; sessionId: string; requestId: string }
  | {
      type: "notification.unread";
      sessionId: string;
      unreadCount: number;
      hasUnreadCompletion: boolean;
      hasUnreadError: boolean;
    }
  | { type: "backend.degraded"; reason: string };

export const SESSION_FILTERS = ["all", "running", "unread", "completed", "interrupted", "error", "archived"] as const;
export type SessionFilter = (typeof SESSION_FILTERS)[number];

export function matchesSessionFilter(
  session: Pick<SessionSummary, "status" | "isArchived" | "hasUnreadCompletion" | "hasUnreadError">,
  filter?: SessionFilter
) {
  if (!filter || filter === "all") {
    return true;
  }

  if (filter === "unread") {
    return session.hasUnreadCompletion || session.hasUnreadError;
  }

  if (filter === "archived") {
    return session.isArchived;
  }

  return !session.isArchived && session.status === filter;
}
