import type {
  CodexCommandAction,
  CodexCommandApprovalDecision,
  CodexFileChangeApprovalDecision,
  CodexPendingRequest,
  CodexPendingRequestResponse,
  CodexRequestUserInputOption,
  CodexRequestUserInputQuestion,
  JsonValue
} from "@codex-remote/shared-types";

export type PendingServerRequestParseInput = {
  requestId: number | string;
  method: string;
  params: unknown;
  createdAt: string;
  sessionIdForRequest: (threadId: string, turnId: string | null) => string;
};

export function parsePendingServerRequest(input: PendingServerRequestParseInput): CodexPendingRequest | null {
  const payload = asObject(input.params);
  if (!payload) {
    return null;
  }

  const id = String(input.requestId);

  if (input.method === "item/commandExecution/requestApproval") {
    const threadId = stringField(payload, "threadId");
    const turnId = stringField(payload, "turnId");
    if (!threadId || !turnId) {
      return null;
    }

    return {
      type: "command_approval",
      id,
      sessionId: input.sessionIdForRequest(threadId, turnId),
      threadId,
      turnId,
      itemId: stringField(payload, "itemId") ?? null,
      createdAt: input.createdAt,
      approvalId: stringField(payload, "approvalId") ?? null,
      reason: stringField(payload, "reason") ?? null,
      networkApprovalContext: networkApprovalContext(payload.networkApprovalContext),
      command: stringField(payload, "command") ?? null,
      cwd: stringField(payload, "cwd") ?? null,
      commandActions: commandActions(payload.commandActions),
      requestedPermissions: requestedPermissions(payload.additionalPermissions),
      availableDecisions: commandApprovalDecisions(payload.availableDecisions)
    };
  }

  if (input.method === "item/fileChange/requestApproval") {
    const threadId = stringField(payload, "threadId");
    const turnId = stringField(payload, "turnId");
    if (!threadId || !turnId) {
      return null;
    }

    return {
      type: "file_change_approval",
      id,
      sessionId: input.sessionIdForRequest(threadId, turnId),
      threadId,
      turnId,
      itemId: stringField(payload, "itemId") ?? null,
      createdAt: input.createdAt,
      reason: stringField(payload, "reason") ?? null,
      grantRoot: stringField(payload, "grantRoot") ?? null,
      availableDecisions: fileChangeApprovalDecisions(payload.availableDecisions)
    };
  }

  if (input.method === "item/permissions/requestApproval") {
    const threadId = stringField(payload, "threadId");
    const turnId = stringField(payload, "turnId");
    const permissions = requestedPermissions(payload.permissions);
    if (!threadId || !turnId || !permissions) {
      return null;
    }

    return {
      type: "permissions_approval",
      id,
      sessionId: input.sessionIdForRequest(threadId, turnId),
      threadId,
      turnId,
      itemId: stringField(payload, "itemId") ?? null,
      createdAt: input.createdAt,
      reason: stringField(payload, "reason") ?? null,
      permissions
    };
  }

  if (input.method === "item/tool/requestUserInput") {
    const threadId = stringField(payload, "threadId");
    const turnId = stringField(payload, "turnId");
    if (!threadId || !turnId) {
      return null;
    }

    return {
      type: "request_user_input",
      id,
      sessionId: input.sessionIdForRequest(threadId, turnId),
      threadId,
      turnId,
      itemId: stringField(payload, "itemId") ?? null,
      createdAt: input.createdAt,
      questions: requestUserInputQuestions(payload.questions)
    };
  }

  if (input.method === "mcpServer/elicitation/request") {
    const threadId = stringField(payload, "threadId");
    const serverName = stringField(payload, "serverName");
    const mode = stringField(payload, "mode");
    const message = stringField(payload, "message");
    if (!threadId || !serverName || !mode || !message) {
      return null;
    }

    const turnId = stringField(payload, "turnId") ?? null;
    const base = {
      type: "mcp_elicitation" as const,
      id,
      sessionId: input.sessionIdForRequest(threadId, turnId),
      threadId,
      turnId,
      itemId: null,
      createdAt: input.createdAt,
      serverName,
      message,
      meta: jsonValue(payload._meta)
    };

    if (mode === "form") {
      return {
        ...base,
        mode,
        requestedSchema: jsonValue(payload.requestedSchema) ?? {}
      };
    }

    if (mode === "url") {
      const url = stringField(payload, "url");
      const elicitationId = stringField(payload, "elicitationId");
      if (!url || !elicitationId) {
        return null;
      }

      return {
        ...base,
        mode,
        url,
        elicitationId
      };
    }
  }

  return null;
}

export function resultForPendingRequestResponse(
  request: CodexPendingRequest,
  response: CodexPendingRequestResponse
) {
  if (request.type === "command_approval" && response.type === "command_approval") {
    return {
      decision: response.decision
    };
  }

  if (request.type === "file_change_approval" && response.type === "file_change_approval") {
    return {
      decision: response.decision
    };
  }

  if (request.type === "permissions_approval" && response.type === "permissions_approval") {
    return {
      permissions: response.permissions,
      scope: response.scope
    };
  }

  if (request.type === "request_user_input" && response.type === "request_user_input") {
    return {
      answers: response.answers
    };
  }

  if (request.type === "mcp_elicitation" && response.type === "mcp_elicitation") {
    return {
      action: response.action,
      content: response.content,
      _meta: response.meta ?? null
    };
  }

  throw new Error(`Unsupported Codex request response: ${request.type}`);
}

function networkApprovalContext(value: unknown) {
  const payload = asObject(value);
  const host = stringField(payload, "host");
  const protocol = stringField(payload, "protocol");
  return host && protocol ? { host, protocol } : null;
}

function commandActions(value: unknown): CodexCommandAction[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const actions: CodexCommandAction[] = [];
  for (const entry of value) {
    const payload = asObject(entry);
    if (!payload) {
      continue;
    }
    const type = stringField(payload, "type");
    const command = stringField(payload, "command");
    if (!type || !command) {
      continue;
    }

    if (type === "read") {
      const name = stringField(payload, "name");
      const path = stringField(payload, "path");
      if (name && path) {
        actions.push({ type, command, name, path });
      }
      continue;
    }

    if (type === "listFiles") {
      actions.push({ type, command, path: stringField(payload, "path") ?? null });
      continue;
    }

    if (type === "search") {
      actions.push({
        type,
        command,
        query: stringField(payload, "query") ?? null,
        path: stringField(payload, "path") ?? null
      });
      continue;
    }

    if (type === "unknown") {
      actions.push({ type, command });
    }
  }

  return actions.length > 0 ? actions : null;
}

function commandApprovalDecisions(value: unknown): CodexCommandApprovalDecision[] {
  if (!Array.isArray(value)) {
    return ["accept", "decline", "cancel"];
  }

  const decisions: CodexCommandApprovalDecision[] = [];
  for (const entry of value) {
    if (
      entry === "accept" ||
      entry === "acceptForSession" ||
      entry === "decline" ||
      entry === "cancel"
    ) {
      decisions.push(entry);
    }
  }

  return decisions.length > 0 ? decisions : ["accept", "decline", "cancel"];
}

function fileChangeApprovalDecisions(value: unknown): CodexFileChangeApprovalDecision[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const decisions: CodexFileChangeApprovalDecision[] = [];
  for (const entry of value) {
    if (
      entry === "accept" ||
      entry === "acceptForSession" ||
      entry === "decline" ||
      entry === "cancel"
    ) {
      decisions.push(entry);
    }
  }

  return decisions.length > 0 ? decisions : null;
}

function requestedPermissions(value: unknown) {
  const payload = asObject(value);
  if (!payload) {
    return null;
  }

  const fileSystem = asObject(payload.fileSystem);
  const network = asObject(payload.network);
  const read = stringArray(fileSystem?.read);
  const write = stringArray(fileSystem?.write);
  const enabled = booleanField(network, "enabled");
  const normalized = {
    fileSystem: read || write ? { read, write } : null,
    network: enabled !== undefined ? { enabled } : null
  };

  return normalized.fileSystem || normalized.network ? normalized : null;
}

function requestUserInputQuestions(value: unknown): CodexRequestUserInputQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const questions: CodexRequestUserInputQuestion[] = [];
  for (const entry of value) {
    const payload = asObject(entry);
    if (!payload) {
      continue;
    }
    const id = stringField(payload, "id");
    const header = stringField(payload, "header");
    const question = stringField(payload, "question");
    if (!id || !header || !question) {
      continue;
    }

    questions.push({
      id,
      header,
      question,
      isOther: booleanField(payload, "isOther") ?? false,
      isSecret: booleanField(payload, "isSecret") ?? false,
      options: requestUserInputOptions(payload.options)
    });
  }

  return questions;
}

function requestUserInputOptions(value: unknown): CodexRequestUserInputOption[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const options: CodexRequestUserInputOption[] = [];
  for (const entry of value) {
    const payload = asObject(entry);
    if (!payload) {
      continue;
    }
    const label = stringField(payload, "label");
    const description = stringField(payload, "description");
    if (label && description) {
      options.push({ label, description });
    }
  }

  return options.length > 0 ? options : null;
}

function jsonValue(value: unknown): JsonValue | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value) ||
    (value && typeof value === "object")
  ) {
    return value as JsonValue;
  }

  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function booleanField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }

  const items = value.filter((entry): entry is string => typeof entry === "string");
  return items.length > 0 ? items : null;
}
