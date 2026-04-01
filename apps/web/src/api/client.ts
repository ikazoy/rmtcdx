import type {
  AccountRateLimitsResponse,
  CodexModelsResponse,
  CodexPendingRequestResponse,
  CreateRunRequest,
  CreateSessionRequest,
  DeletePushSubscriptionRequest,
  HealthResponse,
  MessagesResponse,
  NotificationsConfigResponse,
  PendingCodexRequestsResponse,
  ReposResponse,
  RunResponse,
  SessionFilePreviewRequest,
  SessionFilePreviewResponse,
  SavePushSubscriptionRequest,
  SessionDetail,
  SimulateCodexRequestRequest,
  SimulateCodexRequestResponse,
  SessionsResponse,
  UpdateSessionRequest
} from "@codex-remote/shared-types";

async function request<T>(input: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(input, {
    headers,
    ...init
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export const api = {
  health: () => request<HealthResponse>("/healthz"),
  codexModels: () => request<CodexModelsResponse>("/api/codex/models"),
  accountRateLimits: () => request<AccountRateLimitsResponse>("/api/account/rate-limits"),
  notificationsConfig: () => request<NotificationsConfigResponse>("/api/notifications/config"),
  repos: () => request<ReposResponse>("/api/repos"),
  sessions: (repoId: string | null, search: string, filter: string) => {
    const query = new URLSearchParams();
    if (repoId) {
      query.set("repoId", repoId);
    }
    if (search.trim()) {
      query.set("q", search.trim());
    }
    if (filter && filter !== "all") {
      query.set("filter", filter);
    }
    const path = search.trim() ? `/api/sessions/search?${query.toString()}` : `/api/sessions?${query.toString()}`;
    return request<SessionsResponse>(path);
  },
  session: (sessionId: string) => request<SessionDetail>(`/api/sessions/${sessionId}`),
  messages: (sessionId: string) => request<MessagesResponse>(`/api/sessions/${sessionId}/messages`),
  filePreview: (sessionId: string, payload: SessionFilePreviewRequest) =>
    request<SessionFilePreviewResponse>(`/api/sessions/${sessionId}/files/preview`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  pendingCodexRequests: (sessionId: string) =>
    request<PendingCodexRequestsResponse>(`/api/sessions/${sessionId}/codex/requests`),
  createSession: (payload: CreateSessionRequest) =>
    request<{ session: SessionDetail["session"] }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  renameSession: (sessionId: string, payload: UpdateSessionRequest) =>
    request<SessionDetail>(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  archiveSession: (sessionId: string) =>
    request<SessionDetail>(`/api/sessions/${sessionId}/archive`, {
      method: "POST"
    }),
  restoreSession: (sessionId: string) =>
    request<SessionDetail>(`/api/sessions/${sessionId}/restore`, {
      method: "POST"
    }),
  markRead: (sessionId: string) =>
    request<{ ok: true }>(`/api/sessions/${sessionId}/read`, {
      method: "POST"
    }),
  startRun: (payload: CreateRunRequest) =>
    request<RunResponse>("/api/runs", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  interruptRun: (runId: string) =>
    request<{ ok: true }>(`/api/runs/${runId}/interrupt`, {
      method: "POST"
    }),
  respondToCodexRequest: (requestId: string, payload: CodexPendingRequestResponse) =>
    request<{ ok: true }>(`/api/codex/requests/${requestId}/respond`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  simulateCodexRequest: (sessionId: string, payload: SimulateCodexRequestRequest) =>
    request<SimulateCodexRequestResponse>(`/api/dev/sessions/${sessionId}/codex/requests`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  savePushSubscription: (payload: SavePushSubscriptionRequest) =>
    request<{ ok: true }>("/api/notifications/subscriptions", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  deletePushSubscription: (payload: DeletePushSubscriptionRequest) =>
    request<{ ok: true }>("/api/notifications/subscriptions", {
      method: "DELETE",
      body: JSON.stringify(payload)
    })
};
