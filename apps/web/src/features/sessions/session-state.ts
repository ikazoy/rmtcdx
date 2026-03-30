import type { SessionSummary } from "../../../../../packages/shared-types/src/index";

export function sessionDisplayStatus(session: Pick<SessionSummary, "isArchived" | "status">) {
  return session.isArchived ? "archived" : session.status;
}
