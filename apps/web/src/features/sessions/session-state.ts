import type { SessionSummary } from "@codex-remote/shared-types";

export function sessionDisplayStatus(session: Pick<SessionSummary, "isArchived" | "status">) {
  return session.isArchived ? "archived" : session.status;
}

export function sessionIndicatorTone(
  session: Pick<SessionSummary, "isArchived" | "status" | "pendingRequestCount">
) {
  if (!session.isArchived && session.pendingRequestCount > 0) {
    return "pending";
  }

  return sessionDisplayStatus(session);
}
