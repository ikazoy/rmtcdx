import type {
  CreateRunRequest,
  CreateSessionRequest,
  HealthResponse,
  MessagesResponse,
  ReposResponse,
  RunResponse,
  SessionDetail,
  SessionsResponse
} from "../../../../packages/shared-types/src/index";

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
  repos: () => request<ReposResponse>("/api/repos"),
  sessions: (repoId: string, search: string, filter: string) => {
    const query = new URLSearchParams({ repoId });
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
  createSession: (payload: CreateSessionRequest) =>
    request<{ session: SessionDetail["session"] }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(payload)
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
    })
};
