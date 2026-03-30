export const queryKeys = {
  health: ["health"] as const,
  codexModels: ["codex-models"] as const,
  accountRateLimits: ["account-rate-limits"] as const,
  repos: ["repos"] as const,
  sessions: (repoId: string | null, search: string, filter: string) =>
    ["sessions", repoId, search, filter] as const,
  session: (sessionId: string | null) => ["session", sessionId] as const,
  messages: (sessionId: string | null) => ["messages", sessionId] as const,
  pendingCodexRequests: (sessionId: string | null) => ["pending-codex-requests", sessionId] as const
};
