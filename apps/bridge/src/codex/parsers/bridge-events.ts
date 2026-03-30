import type { CodexActivityKind, CodexBridgeEvent } from "../types";

type RunMapping = {
  sessionId: string;
  runId: string;
};

type NotificationItem = {
  id?: string;
  type?: string;
  text?: string;
  phase?: string | null;
  status?: string;
  tool?: string;
  server?: string;
  command?: string;
};

export type BridgeNotificationDebugEntry = {
  event: string;
  fields?: Record<string, unknown>;
};

export type ParsedBridgeNotification = {
  events: CodexBridgeEvent[];
  debugEntries: BridgeNotificationDebugEntry[];
  finishedTurn:
    | {
        turnId: string;
        status: "completed" | "interrupted" | "failed";
        message?: string;
      }
    | null;
};

export function parseBridgeNotification(
  method: string,
  params: unknown,
  runByTurn: ReadonlyMap<string, RunMapping>
): ParsedBridgeNotification {
  const payload = asObject(params);
  if (!payload) {
    return emptyParseResult();
  }

  if (method === "item/agentMessage/delta") {
    const turnId = stringField(payload, "turnId");
    const delta = stringField(payload, "delta");
    if (!turnId || delta === undefined) {
      return emptyParseResult();
    }
    const mapping = runByTurn.get(turnId);
    if (!mapping) {
      return emptyParseResult();
    }
    return {
      events: [
        {
          type: "message.delta",
          sessionId: mapping.sessionId,
          runId: mapping.runId,
          turnId,
          text: delta
        }
      ],
      debugEntries: [],
      finishedTurn: null
    };
  }

  if (method === "item/commandExecution/outputDelta") {
    const turnId = stringField(payload, "turnId");
    const itemId = stringField(payload, "itemId");
    const delta = stringField(payload, "delta");
    if (!turnId || !itemId || delta === undefined) {
      return emptyParseResult();
    }
    const mapping = runByTurn.get(turnId);
    if (!mapping) {
      return emptyParseResult();
    }
    return {
      events: [
        {
          type: "activity.updated",
          sessionId: mapping.sessionId,
          runId: mapping.runId,
          turnId,
          itemId,
          delta
        }
      ],
      debugEntries: [],
      finishedTurn: null
    };
  }

  if (method === "item/fileChange/outputDelta") {
    const turnId = stringField(payload, "turnId");
    const itemId = stringField(payload, "itemId");
    const delta = stringField(payload, "delta");
    if (!turnId || !itemId || delta === undefined) {
      return emptyParseResult();
    }
    const mapping = runByTurn.get(turnId);
    if (!mapping) {
      return emptyParseResult();
    }
    return {
      events: [
        {
          type: "activity.updated",
          sessionId: mapping.sessionId,
          runId: mapping.runId,
          turnId,
          itemId,
          delta
        }
      ],
      debugEntries: [],
      finishedTurn: null
    };
  }

  if (method === "item/started") {
    const turnId = stringField(payload, "turnId");
    const item = notificationItem(payload.item);
    if (!turnId || !item) {
      return emptyParseResult();
    }
    const mapping = runByTurn.get(turnId);
    if (!mapping) {
      return emptyParseResult();
    }

    const events: CodexBridgeEvent[] = [];
    const activity = activityFromItem(item);
    if (activity && item.id) {
      events.push({
        type: "activity.started",
        sessionId: mapping.sessionId,
        runId: mapping.runId,
        turnId,
        itemId: item.id,
        kind: activity.kind,
        label: activity.label
      });
    }

    const toolName = toolNameFromItem(item);
    if (toolName) {
      events.push({
        type: "tool.start",
        sessionId: mapping.sessionId,
        runId: mapping.runId,
        turnId,
        name: toolName
      });
    }

    return {
      events,
      debugEntries: [],
      finishedTurn: null
    };
  }

  if (method === "item/completed") {
    const turnId = stringField(payload, "turnId");
    const item = notificationItem(payload.item);
    if (!turnId || !item) {
      return emptyParseResult();
    }
    const mapping = runByTurn.get(turnId);
    if (!mapping) {
      return emptyParseResult();
    }

    if (item.type === "agentMessage" && item.text) {
      return {
        events: [
          {
            type: "message.final",
            sessionId: mapping.sessionId,
            runId: mapping.runId,
            turnId,
            text: item.text,
            countsUnread: item.phase !== "commentary"
          }
        ],
        debugEntries: [],
        finishedTurn: null
      };
    }

    const events: CodexBridgeEvent[] = [];
    if (item.id && activityFromItem(item)) {
      events.push({
        type: "activity.completed",
        sessionId: mapping.sessionId,
        runId: mapping.runId,
        turnId,
        itemId: item.id
      });
    }

    const toolName = toolNameFromItem(item);
    if (toolName) {
      events.push({
        type: "tool.end",
        sessionId: mapping.sessionId,
        runId: mapping.runId,
        turnId,
        name: toolName,
        ok: !item.status || !["failed", "declined"].includes(item.status)
      });
    }

    return {
      events,
      debugEntries: [],
      finishedTurn: null
    };
  }

  if (method === "turn/completed") {
    const turn = asObject(payload.turn);
    const turnId = stringField(turn, "id") ?? stringField(payload, "turnId");
    if (!turnId) {
      return emptyParseResult();
    }
    const mapping = runByTurn.get(turnId);
    if (!mapping) {
      return emptyParseResult();
    }

    const status = stringField(turn, "status");
    if (status === "completed") {
      return {
        events: [
          {
            type: "run.completed",
            sessionId: mapping.sessionId,
            runId: mapping.runId,
            turnId
          }
        ],
        debugEntries: [],
        finishedTurn: {
          turnId,
          status: "completed"
        }
      };
    }

    if (status === "interrupted") {
      return {
        events: [
          {
            type: "run.interrupted",
            sessionId: mapping.sessionId,
            runId: mapping.runId,
            turnId
          }
        ],
        debugEntries: [],
        finishedTurn: {
          turnId,
          status: "interrupted"
        }
      };
    }

    const message = stringField(asObject(turn?.error), "message") ?? "Codex turn failed";
    return {
      events: [
        {
          type: "run.error",
          sessionId: mapping.sessionId,
          runId: mapping.runId,
          turnId,
          message
        }
      ],
      debugEntries: [],
      finishedTurn: {
        turnId,
        status: "failed",
        message
      }
    };
  }

  if (method === "error") {
    const turnId = stringField(payload, "turnId");
    const threadId = stringField(payload, "threadId");
    const message = stringField(asObject(payload.error), "message") ?? "Codex backend error";

    if (!turnId) {
      return {
        events: [
          {
            type: "backend.degraded",
            reason: message
          }
        ],
        debugEntries: [
          {
            event: "backend.error",
            fields: {
              threadId: threadId ?? null,
              message
            }
          }
        ],
        finishedTurn: null
      };
    }

    const mapping = runByTurn.get(turnId);
    if (!mapping) {
      return emptyParseResult();
    }

    return {
      events: [
        {
          type: "run.error",
          sessionId: mapping.sessionId,
          runId: mapping.runId,
          turnId,
          message
        }
      ],
      debugEntries: [],
      finishedTurn: {
        turnId,
        status: "failed",
        message
      }
    };
  }

  if (method === "thread/started") {
    const thread = asObject(payload.thread);
    return debugOnly("thread.started", {
      threadId: stringField(thread, "id") ?? null,
      cwd: stringField(thread, "cwd") ?? null,
      path: stringField(thread, "path") ?? null,
      status: stringField(asObject(thread?.status), "type") ?? null
    });
  }

  if (method === "thread/status/changed") {
    return debugOnly("thread.status.changed", {
      threadId: stringField(payload, "threadId") ?? null,
      status: stringField(asObject(payload.status), "type") ?? null,
      activeFlags: stringArrayField(asObject(payload.status), "activeFlags")
    });
  }

  if (method === "turn/started") {
    const turn = asObject(payload.turn);
    return debugOnly("turn.started", {
      threadId: stringField(payload, "threadId") ?? null,
      turnId: stringField(turn, "id") ?? null,
      status: stringField(turn, "status") ?? null
    });
  }

  if (method === "turn/diff/updated") {
    const diff = stringField(payload, "diff");
    return debugOnly("turn.diff.updated", {
      threadId: stringField(payload, "threadId") ?? null,
      turnId: stringField(payload, "turnId") ?? null,
      diffLength: diff?.length ?? 0,
      diffLineCount: diff ? diff.split("\n").length : 0
    });
  }

  if (method === "thread/tokenUsage/updated") {
    const tokenUsage = asObject(payload.tokenUsage);
    const total = asObject(tokenUsage?.total);
    const last = asObject(tokenUsage?.last);
    return debugOnly("thread.token_usage.updated", {
      threadId: stringField(payload, "threadId") ?? null,
      turnId: stringField(payload, "turnId") ?? null,
      totalTokens: numberField(total, "totalTokens"),
      lastTokens: numberField(last, "totalTokens"),
      modelContextWindow: numberField(tokenUsage, "modelContextWindow")
    });
  }

  if (method === "account/rateLimits/updated") {
    const rateLimits = asObject(payload.rateLimits);
    const primary = asObject(rateLimits?.primary);
    const secondary = asObject(rateLimits?.secondary);
    return debugOnly("account.rate_limits.updated", {
      limitId: stringField(rateLimits, "limitId") ?? null,
      planType: stringField(rateLimits, "planType") ?? null,
      primaryUsedPercent: numberField(primary, "usedPercent"),
      secondaryUsedPercent: numberField(secondary, "usedPercent")
    });
  }

  return {
    events: [],
    debugEntries: [
      {
        event: "notification.unhandled",
        fields: {
          method,
          params
        }
      }
    ],
    finishedTurn: null
  };
}

export function toolNameFromItem(item: Pick<NotificationItem, "type" | "tool" | "server" | "command">) {
  if (!item.type) {
    return null;
  }
  if (item.type === "commandExecution") {
    return item.command ? `shell:${item.command.split(" ")[0]}` : "shell";
  }
  if (item.type === "mcpToolCall") {
    return item.server && item.tool ? `${item.server}:${item.tool}` : item.tool ?? "mcp";
  }
  if (item.type === "dynamicToolCall") {
    return item.tool ?? "tool";
  }
  if (item.type === "fileChange") {
    return "apply_patch";
  }
  if (item.type === "webSearch") {
    return "web_search";
  }
  if (item.type === "collabAgentToolCall") {
    return item.tool ?? "agent";
  }
  return null;
}

export function activityFromItem(item: Pick<NotificationItem, "type" | "tool" | "server" | "command">) {
  if (!item.type) {
    return null;
  }
  if (item.type === "commandExecution") {
    return {
      kind: "command" as CodexActivityKind,
      label: item.command ?? "shell command"
    };
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall" || item.type === "collabAgentToolCall") {
    return {
      kind: "tool" as CodexActivityKind,
      label: item.server && item.tool ? `${item.server}:${item.tool}` : item.tool ?? "tool"
    };
  }
  if (item.type === "fileChange") {
    return {
      kind: "file" as CodexActivityKind,
      label: "Applying file changes"
    };
  }
  if (item.type === "webSearch") {
    return {
      kind: "search" as CodexActivityKind,
      label: "Running web search"
    };
  }
  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
    return {
      kind: "review" as CodexActivityKind,
      label: "Review mode"
    };
  }
  return null;
}

function emptyParseResult(): ParsedBridgeNotification {
  return {
    events: [],
    debugEntries: [],
    finishedTurn: null
  };
}

function debugOnly(event: string, fields: Record<string, unknown>): ParsedBridgeNotification {
  return {
    events: [],
    debugEntries: [{ event, fields }],
    finishedTurn: null
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "number" ? value : null;
}

function stringArrayField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  if (!Array.isArray(value)) {
    return null;
  }
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length === value.length ? strings : null;
}

function notificationItem(value: unknown): NotificationItem | null {
  const record = asObject(value);
  if (!record) {
    return null;
  }
  return {
    id: stringField(record, "id"),
    type: stringField(record, "type"),
    text: stringField(record, "text"),
    phase: typeof record.phase === "string" || record.phase === null ? (record.phase as string | null) : undefined,
    status: stringField(record, "status"),
    tool: stringField(record, "tool"),
    server: stringField(record, "server"),
    command: stringField(record, "command")
  };
}
