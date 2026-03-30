import type { SessionSummary } from "@codex-remote/shared-types";

export function sessionDisplayStatus(session: Pick<SessionSummary, "isArchived" | "status">) {
  return session.isArchived ? "archived" : session.status;
}
