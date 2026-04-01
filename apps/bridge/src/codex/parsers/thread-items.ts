import path from "node:path";

import type { Message, MessageAttachment } from "@codex-remote/shared-types";
import type { CodexThread, CodexThreadItem, CodexUserInput } from "../types";

export type ThreadItemUploadResolver = {
  publicUrlForPath(filePath: string): string | null;
  displayNameForPath(filePath: string): string;
};

export type ThreadItemMapOptions = {
  uploads: ThreadItemUploadResolver;
  onUnknownItem?: (item: CodexThreadItem) => void;
};

const knownThreadItemTypes = new Set([
  "userMessage",
  "agentMessage",
  "plan",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction"
]);

export function mapThreadToMessages(thread: CodexThread, options: ThreadItemMapOptions) {
  const messages: Message[] = [];
  const baseTime = thread.createdAt * 1000;
  let offset = 0;

  for (const turn of thread.turns) {
    for (const item of turn.items) {
      const createdAt = new Date(baseTime + offset * 1000).toISOString();
      offset += 1;
      const message = mapThreadItemToMessage(thread.id, item, createdAt, options);
      if (message) {
        messages.push(message);
      }
    }

    if (turn.status === "failed" && turn.error?.message) {
      messages.push({
        id: `${turn.id}:error`,
        sessionId: thread.id,
        role: "system",
        kind: "run_error",
        text: turn.error.message,
        createdAt: new Date(baseTime + offset * 1000).toISOString(),
        status: "error"
      });
      offset += 1;
    }
  }

  return messages;
}

export function findLatestUserMessagePreview(thread: CodexThread, uploads: ThreadItemUploadResolver) {
  for (let turnIndex = thread.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = thread.turns[turnIndex];
    if (!turn) {
      continue;
    }

    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex];
      if (!item || item.type !== "userMessage" || !("content" in item)) {
        continue;
      }

      const content = formatUserMessage(item.content, uploads);
      const text = content.text.trim();
      if (text) {
        return text;
      }

      if (content.attachments.length > 0) {
        return `Sent ${content.attachments.length} image${content.attachments.length === 1 ? "" : "s"}`;
      }
    }
  }

  return null;
}

export function mapThreadItemToMessage(
  sessionId: string,
  item: CodexThreadItem,
  createdAt: string,
  options: ThreadItemMapOptions
): Message | null {
  if (item.type === "userMessage" && "content" in item) {
    const content = formatUserMessage(item.content, options.uploads);
    return content.text || content.attachments.length
      ? {
          id: item.id,
          sessionId,
          role: "user",
          kind: "user_message",
          text: content.text,
          attachments: content.attachments,
          createdAt
        }
      : null;
  }

  if (item.type === "agentMessage" && "text" in item) {
    return item.text
      ? {
          id: item.id,
          sessionId,
          role: "assistant",
          kind: item.phase === "commentary" ? "assistant_thinking" : "assistant_message",
          text: item.text,
          createdAt,
          status: item.phase ?? undefined
        }
      : null;
  }

  if (item.type === "plan" && "text" in item) {
    return { id: item.id, sessionId, role: "assistant", kind: "plan", text: item.text, createdAt };
  }

  if (item.type === "reasoning" && "summary" in item && "content" in item) {
    return {
      id: item.id,
      sessionId,
      role: "assistant",
      kind: "reasoning",
      text: [...item.summary, ...item.content].filter(Boolean).join("\n\n"),
      createdAt
    };
  }

  if (item.type === "commandExecution" && "command" in item && "aggregatedOutput" in item) {
    return {
      id: item.id,
      sessionId,
      role: "system",
      kind: "command_execution",
      text: formatCommandExecution(item.command, item.aggregatedOutput, item.exitCode),
      createdAt,
      status: item.status,
      metadata: {
        type: "command_execution",
        command: item.command,
        cwd: item.cwd,
        output: item.aggregatedOutput,
        exitCode: item.exitCode,
        durationMs: item.durationMs
      }
    };
  }

  if (item.type === "fileChange" && "changes" in item && "status" in item) {
    return {
      id: item.id,
      sessionId,
      role: "system",
      kind: "file_change",
      text: `Updated ${item.changes.length} file${item.changes.length === 1 ? "" : "s"}.`,
      createdAt,
      status: item.status,
      metadata: {
        type: "file_change",
        changes: item.changes.map((change) => ({
          path: change.path,
          kind: change.kind.type,
          movePath: change.kind.type === "update" ? change.kind.move_path : undefined,
          diff: change.diff
        }))
      }
    };
  }

  if (item.type === "mcpToolCall" && "server" in item && "tool" in item && "status" in item) {
    return {
      id: item.id,
      sessionId,
      role: "system",
      kind: "mcp_tool_call",
      text: `Server: \`${item.server}\`\nTool: \`${item.tool}\``,
      createdAt,
      status: item.status
    };
  }

  if (item.type === "dynamicToolCall" && "tool" in item && "status" in item) {
    return {
      id: item.id,
      sessionId,
      role: "system",
      kind: "dynamic_tool_call",
      text: `Tool: \`${item.tool}\``,
      createdAt,
      status: item.status
    };
  }

  if (item.type === "collabAgentToolCall" && "tool" in item && "status" in item && "prompt" in item) {
    return {
      id: item.id,
      sessionId,
      role: "system",
      kind: "collab_agent_tool_call",
      text: [`Agent tool: \`${item.tool}\``, item.prompt ? `Prompt:\n\n${item.prompt}` : ""].filter(Boolean).join("\n\n"),
      createdAt,
      status: item.status
    };
  }

  if (item.type === "webSearch" && "query" in item) {
    return {
      id: item.id,
      sessionId,
      role: "system",
      kind: "web_search",
      text: `Query: ${item.query}`,
      createdAt,
      metadata: {
        type: "web_search",
        query: item.query
      }
    };
  }

  if (item.type === "imageView" && "path" in item) {
    return {
      id: item.id,
      sessionId,
      role: "system",
      kind: "image_view",
      text: `Path: \`${item.path}\``,
      createdAt
    };
  }

  if (item.type === "imageGeneration" && "status" in item && "result" in item) {
    return {
      id: item.id,
      sessionId,
      role: "system",
      kind: "image_generation",
      text: [item.revisedPrompt ? `Prompt: ${item.revisedPrompt}` : "", item.result].filter(Boolean).join("\n\n"),
      createdAt,
      status: item.status
    };
  }

  if ((item.type === "enteredReviewMode" || item.type === "exitedReviewMode") && "review" in item) {
    return {
      id: item.id,
      sessionId,
      role: "system",
      kind: item.type === "enteredReviewMode" ? "review_mode_entered" : "review_mode_exited",
      text: item.review,
      createdAt
    };
  }

  if (item.type === "contextCompaction") {
    return {
      id: item.id,
      sessionId,
      role: "system",
      kind: "context_compaction",
      text: "Context compacted for continuation.",
      createdAt
    };
  }

  if (!knownThreadItemTypes.has(item.type)) {
    options.onUnknownItem?.(item);
  }

  return null;
}

function formatUserMessage(content: CodexUserInput[], uploads: ThreadItemUploadResolver) {
  const lines: string[] = [];
  const attachments: MessageAttachment[] = [];

  for (const part of content) {
    if (part.type === "text" && part.text) {
      lines.push(part.text);
      continue;
    }
    if (part.type === "mention" && part.name) {
      lines.push(`@${part.name}`);
      continue;
    }
    if (part.type === "skill" && part.name) {
      lines.push(`skill:${part.name}`);
      continue;
    }
    if (part.type === "localImage" && part.path) {
      const url = uploads.publicUrlForPath(part.path);
      if (url) {
        attachments.push({
          kind: "image",
          name: uploads.displayNameForPath(part.path),
          url
        });
      } else {
        lines.push(`[local image] ${part.path}`);
      }
      continue;
    }
    if (part.type === "image" && part.url) {
      attachments.push({
        kind: "image",
        name: imageNameFromUrl(part.url, attachments.length + 1),
        url: part.url
      });
    }
  }

  return {
    text: lines.join("\n"),
    attachments
  };
}

function imageNameFromUrl(url: string, index: number) {
  if (url.startsWith("data:image/")) {
    return `attached-image-${index}`;
  }

  try {
    const parsed = new URL(url);
    const fromPath = path.basename(parsed.pathname);
    return fromPath || `attached-image-${index}`;
  } catch {
    return `attached-image-${index}`;
  }
}

function formatCommandExecution(command: string, output: string | null, exitCode: number | null) {
  const sections = [`\`\`\`sh\n${command}\n\`\`\``];
  const clippedOutput = output ? clipBlock(output, 2400) : "";
  if (clippedOutput) {
    sections.push(`\`\`\`text\n${clippedOutput}\n\`\`\``);
  }
  if (exitCode !== null) {
    sections.push(`Exit code: ${exitCode}`);
  }

  return sections.join("\n\n");
}

function clipBlock(text: string, max: number) {
  const normalized = text.trim();
  if (normalized.length <= max) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}
