import type {
  CodexMcpElicitationRequest,
  CodexPendingRequest,
  JsonValue
} from "@codex-remote/shared-types";

const REQUEST_SUBTITLE_PREVIEW_MAX = 120;
const MCP_TOOL_NAME_PATTERN = /tool\s+["']([^"']+)["']/i;

function collapseWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncatePreview(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return ".".repeat(maxLength);
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function summarizeCommand(command: string | null) {
  const preview = collapseWhitespace(command ?? "");
  if (!preview) {
    return "Review the requested command below.";
  }

  return truncatePreview(preview, REQUEST_SUBTITLE_PREVIEW_MAX);
}

function isJsonObject(value: JsonValue | null | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toolNameFromMcpMessage(message: string) {
  const match = MCP_TOOL_NAME_PATTERN.exec(message);
  return match?.[1] ?? null;
}

export function isConfirmationOnlyMcpSchema(requestedSchema: JsonValue) {
  if (!isJsonObject(requestedSchema)) {
    return false;
  }

  const type = typeof requestedSchema.type === "string" ? requestedSchema.type : null;
  if (type && type !== "object") {
    return false;
  }

  const properties = isJsonObject(requestedSchema.properties) ? Object.keys(requestedSchema.properties) : [];
  const required = Array.isArray(requestedSchema.required)
    ? requestedSchema.required.filter((entry): entry is string => typeof entry === "string")
    : [];

  return properties.length === 0 && required.length === 0;
}

export function presentMcpElicitation(request: CodexMcpElicitationRequest) {
  const toolName = toolNameFromMcpMessage(request.message);
  const requiresResponseJson = request.mode === "form" && !isConfirmationOnlyMcpSchema(request.requestedSchema);

  return {
    toolName,
    requiresResponseJson,
    title: toolName ? "Tool approval required" : "MCP confirmation required",
    subtitle: toolName ? `${request.serverName} wants to run ${toolName}` : request.serverName,
    primaryActionLabel: request.mode === "form" ? (requiresResponseJson ? "Submit response" : "Allow") : "Accept",
    confirmationCopy:
      request.mode === "form" && !requiresResponseJson
        ? "No additional input is required. Allow this MCP request if it looks correct."
        : null
  };
}

export function requestTitle(request: CodexPendingRequest) {
  switch (request.type) {
    case "command_approval":
      return "Command approval required";
    case "file_change_approval":
      return "File change approval required";
    case "permissions_approval":
      return "Permission approval required";
    case "request_user_input":
      return "Input required";
    case "mcp_elicitation":
      return presentMcpElicitation(request).title;
  }
}

export function requestSubtitle(request: CodexPendingRequest) {
  switch (request.type) {
    case "command_approval":
      return summarizeCommand(request.command);
    case "file_change_approval":
      return request.reason ?? "The assistant wants to apply file changes.";
    case "permissions_approval":
      return request.reason ?? "The assistant wants additional access.";
    case "request_user_input":
      return `${request.questions.length} question${request.questions.length === 1 ? "" : "s"}`;
    case "mcp_elicitation":
      return presentMcpElicitation(request).subtitle;
  }
}
