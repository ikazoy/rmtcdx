import type { SessionSummary } from "@codex-remote/shared-types";

export function sessionDisplayStatus(session: Pick<SessionSummary, "isArchived" | "status">) {
  return session.isArchived ? "archived" : session.status;
}

export type SessionIndicatorTone = "none" | "running" | "completed" | "error" | "pending";

export function sessionIndicatorTone(
  session: Pick<
    SessionSummary,
    "isArchived" | "status" | "pendingRequestCount" | "hasUnreadCompletion" | "hasUnreadError"
  >
): SessionIndicatorTone {
  if (session.isArchived) {
    return "none";
  }

  if (session.pendingRequestCount > 0) {
    return "pending";
  }

  if (session.hasUnreadError || session.status === "error") {
    return "error";
  }

  if (session.status === "running") {
    return "running";
  }

  if (session.hasUnreadCompletion) {
    return "completed";
  }

  return "none";
}
