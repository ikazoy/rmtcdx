import type {
  CodexFileChangeApprovalDecision,
  CodexFileChangeApprovalRequest
} from "@codex-remote/shared-types";

const DEFAULT_FILE_CHANGE_APPROVAL_DECISIONS =
  ["accept", "decline", "cancel"] as const satisfies readonly CodexFileChangeApprovalDecision[];

export function resolveFileChangeApprovalDecisions(
  request: Pick<CodexFileChangeApprovalRequest, "availableDecisions">
): readonly CodexFileChangeApprovalDecision[] {
  return request.availableDecisions?.length ? request.availableDecisions : DEFAULT_FILE_CHANGE_APPROVAL_DECISIONS;
}
