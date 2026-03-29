import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type {
  FileChangeEntry,
  Message,
  MessageAttachment,
  Repository,
  Run,
  SessionDetail,
  SessionFilter,
  SessionSummary
} from "../../../../packages/shared-types/src/index";
import type { RepoConfig } from "../config/repos";
import type { CodexBackend, CodexThread, CodexThreadItem, CodexThreadTurn, CodexUserInput } from "../codex/types";
import { ImageUploadService } from "../uploads/image-upload-service";
import { excerpt } from "../utils/text";

const execFileAsync = promisify(execFile);

type ThreadContext = {
  thread: CodexThread;
  repo: Repository;
};

export class LiveCatalogService {
  private readonly repoRootCache = new Map<string, Promise<{ rootPath: string; branch?: string }>>();
  private readonly repoOverrideByPath: Map<string, RepoConfig>;

  constructor(
    private readonly codex: CodexBackend,
    repoOverrides: RepoConfig[],
    private readonly uploads: ImageUploadService
  ) {
    this.repoOverrideByPath = new Map(repoOverrides.map((repo) => [repo.path, repo]));
  }

  async listRepos() {
    const threads = await this.codex.listThreads({ archived: false });
    const contexts = await this.enrichThreads(threads);
    const grouped = new Map<string, { repo: Repository; threads: ThreadContext[] }>();

    for (const context of contexts) {
      const entry = grouped.get(context.repo.id);
      if (entry) {
        entry.threads.push(context);
        entry.repo.updatedAt =
          new Date(context.repo.updatedAt) > new Date(entry.repo.updatedAt)
            ? context.repo.updatedAt
            : entry.repo.updatedAt;
        entry.repo.runningSessionCount += context.thread.status.type === "active" ? 1 : 0;
      } else {
        grouped.set(context.repo.id, {
          repo: {
            ...context.repo,
            runningSessionCount: context.thread.status.type === "active" ? 1 : 0
          },
          threads: [context]
        });
      }
    }

    for (const override of this.repoOverrideByPath.values()) {
      const repoId = this.repoIdForPath(override.path, override);
      if (grouped.has(repoId)) {
        continue;
      }
      const branch = await this.readBranch(override.path);
      grouped.set(repoId, {
        repo: {
          id: repoId,
          name: override.name,
          path: override.path,
          description: override.description,
          branch: branch ?? undefined,
          pinned: override.pinned,
          runningSessionCount: 0,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString()
        },
        threads: []
      });
    }

    return [...grouped.values()]
      .map((entry) => entry.repo)
      .sort((left, right) => {
        if (left.pinned !== right.pinned) {
          return left.pinned ? -1 : 1;
        }
        return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
      });
  }

  async getRepo(repoId: string) {
    const repos = await this.listRepos();
    return repos.find((repo) => repo.id === repoId) ?? null;
  }

  async listSessions(repoId?: string, options?: { search?: string; filter?: SessionFilter }) {
    const search = options?.search?.trim();
    const threads = await this.codex.listThreads({
      archived: false,
      searchTerm: search || undefined
    });
    const contexts = await this.enrichThreads(threads);

    return contexts
      .filter((context) => !repoId || context.repo.id === repoId)
      .map((context) => this.mapThreadSummary(context))
      // `thread/list.searchTerm` is part of the protocol, but current Codex CLI builds may still
      // return unfiltered pages. Re-apply the same title-only match here so the UI stays aligned.
      .filter((session) => this.matchesSearch(session, search))
      .filter((session) => this.matchesFilter(session, options?.filter))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }

  async getSessionDetail(sessionId: string, runOverride?: { activeRun: Run | null; latestRun: Run | null }) {
    const thread = await this.readThreadWithFallback(sessionId, true);
    const context = await this.enrichThread(thread);
    const derivedRuns = this.deriveRuns(thread);

    return {
      session: this.mapThreadSummary(context),
      activeRun: runOverride?.activeRun ?? derivedRuns.activeRun,
      latestRun: runOverride?.latestRun ?? derivedRuns.latestRun
    } satisfies SessionDetail;
  }

  async listMessages(sessionId: string) {
    const thread = await this.readThreadWithFallback(sessionId, true);
    return this.mapMessages(thread);
  }

  async createSession(repoId: string) {
    const repo = await this.getRepo(repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${repoId}`);
    }

    const { threadId } = await this.codex.createThread(repo.path);
    const detail = await this.getSessionDetail(threadId);
    return detail.session;
  }

  async renameSession(sessionId: string, title: string) {
    const nextTitle = title.trim();
    if (!nextTitle) {
      throw new Error("Title is required");
    }

    await this.codex.setThreadName(sessionId, nextTitle);
    return this.getSessionDetail(sessionId);
  }

  async archiveSession(sessionId: string) {
    await this.readThreadWithFallback(sessionId, false);
    await this.codex.archiveThread(sessionId);
  }

  async getThread(sessionId: string) {
    return this.codex.readThread(sessionId, { includeTurns: false });
  }

  private matchesFilter(session: SessionSummary, filter?: SessionFilter) {
    if (!filter || filter === "all") {
      return true;
    }
    if (filter === "unread") {
      return session.hasUnreadCompletion || session.hasUnreadError;
    }
    return session.status === filter;
  }

  private matchesSearch(session: SessionSummary, search?: string) {
    if (!search) {
      return true;
    }

    return session.title.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  }

  private async enrichThreads(threads: CodexThread[]) {
    return Promise.all(threads.map((thread) => this.enrichThread(thread)));
  }

  private async enrichThread(thread: CodexThread): Promise<ThreadContext> {
    const repoResolution = await this.resolveRepo(thread.cwd, thread.gitInfo?.branch ?? undefined);
    const override = this.repoOverrideByPath.get(repoResolution.rootPath);
    const repoId = this.repoIdForPath(repoResolution.rootPath, override);
    const updatedAt = this.toIso(thread.updatedAt);
    const createdAt = this.toIso(thread.createdAt);

    return {
      thread,
      repo: {
        id: repoId,
        name: override?.name ?? path.basename(repoResolution.rootPath),
        path: repoResolution.rootPath,
        description: override?.description,
        branch: repoResolution.branch ?? thread.gitInfo?.branch ?? undefined,
        pinned: override?.pinned ?? false,
        runningSessionCount: 0,
        createdAt,
        updatedAt
      }
    };
  }

  private mapThreadSummary(context: ThreadContext): SessionSummary {
    const title = this.threadTitle(context.thread, context.repo.name);
    const summary = context.thread.preview.trim()
      ? excerpt(context.thread.preview, 140)
      : `Start a conversation in ${context.repo.name}`;
    const status = this.mapThreadStatus(context.thread);
    const updatedAt = this.toIso(context.thread.updatedAt);
    const createdAt = this.toIso(context.thread.createdAt);

    return {
      id: context.thread.id,
      repoId: context.repo.id,
      repoName: context.repo.name,
      title,
      summary,
      codexThreadId: context.thread.id,
      status,
      unreadCount: 0,
      lastEventSeq: 0,
      lastReadEventSeq: 0,
      lastMessageAt: updatedAt,
      lastRunFinishedAt: status === "running" ? undefined : updatedAt,
      latestUserPrompt: context.thread.preview.trim() || undefined,
      latestAssistantExcerpt: undefined,
      hasUnreadCompletion: false,
      hasUnreadError: false,
      createdAt,
      updatedAt
    };
  }

  private mapMessages(thread: CodexThread) {
    const messages: Message[] = [];
    const baseTime = thread.createdAt * 1000;
    let offset = 0;

    for (const turn of thread.turns) {
      for (const item of turn.items) {
        const createdAt = new Date(baseTime + offset * 1000).toISOString();
        offset += 1;
        const message = this.mapItemToMessage(thread.id, item, createdAt);
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

  private mapItemToMessage(sessionId: string, item: CodexThreadItem, createdAt: string): Message | null {
    if (item.type === "userMessage" && "content" in item) {
      const content = this.formatUserMessage(item.content);
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
        text: this.formatCommandExecution(item.command, item.aggregatedOutput, item.exitCode),
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
          changes: item.changes.map((change) => this.mapFileChange(change))
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

    return null;
  }

  private formatUserMessage(content: CodexUserInput[]) {
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
        const url = this.uploads.publicUrlForPath(part.path);
        if (url) {
          attachments.push({
            kind: "image",
            name: this.uploads.displayNameForPath(part.path),
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
          name: this.imageNameFromUrl(part.url, attachments.length + 1),
          url: part.url
        });
      }
    }

    return {
      text: lines.join("\n"),
      attachments
    };
  }

  private imageNameFromUrl(url: string, index: number) {
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

  private formatCommandExecution(command: string, output: string | null, exitCode: number | null) {
    const sections = [`\`\`\`sh\n${command}\n\`\`\``];
    const clippedOutput = output ? this.clipBlock(output, 2400) : "";

    if (clippedOutput) {
      sections.push(`\`\`\`text\n${clippedOutput}\n\`\`\``);
    }
    if (exitCode !== null) {
      sections.push(`Exit code: ${exitCode}`);
    }

    return sections.join("\n\n");
  }

  private mapFileChange(change: {
    path: string;
    kind: { type: "add" } | { type: "delete" } | { type: "update"; move_path: string | null };
    diff: string;
  }): FileChangeEntry {
    return {
      path: change.path,
      kind: change.kind.type,
      movePath: change.kind.type === "update" ? change.kind.move_path : undefined,
      diff: change.diff
    };
  }

  private clipBlock(text: string, max: number) {
    const normalized = text.trim();
    if (normalized.length <= max) {
      return normalized;
    }

    return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  }

  private deriveRuns(thread: CodexThread) {
    const latestTurn = thread.turns.at(-1);
    if (!latestTurn) {
      return {
        activeRun: null,
        latestRun: null
      };
    }

    const run: Run = {
      id: latestTurn.id,
      sessionId: thread.id,
      turnId: latestTurn.id,
      status: this.mapTurnStatus(latestTurn),
      startedAt: this.toIso(thread.updatedAt),
      finishedAt: latestTurn.status === "inProgress" ? undefined : this.toIso(thread.updatedAt),
      errorMessage: latestTurn.error?.message ?? undefined
    };

    return {
      activeRun: latestTurn.status === "inProgress" ? run : null,
      latestRun: run
    };
  }

  private mapTurnStatus(turn: CodexThreadTurn): Run["status"] {
    switch (turn.status) {
      case "completed":
        return "completed";
      case "interrupted":
        return "interrupted";
      case "failed":
        return "error";
      default:
        return "running";
    }
  }

  private mapThreadStatus(thread: CodexThread): SessionSummary["status"] {
    if (thread.status.type === "active") {
      return "running";
    }
    if (thread.status.type === "systemError") {
      return "error";
    }
    if (!thread.preview.trim() && !thread.name) {
      return "idle";
    }
    return "completed";
  }

  private threadTitle(thread: CodexThread, fallback: string) {
    const extractedTitle = this.searchableThreadTitle(thread, fallback);
    if (thread.name?.trim()) {
      return extractedTitle;
    }
    return excerpt(extractedTitle, 64);
  }

  private searchableThreadTitle(thread: CodexThread, fallback: string) {
    if (thread.name?.trim()) {
      return thread.name.trim();
    }

    const preview = thread.preview.trim();
    if (preview) {
      return (preview.split("\n")[0] ?? preview).trim();
    }

    return fallback ? "New session" : "New thread";
  }

  private async readThreadWithFallback(threadId: string, includeTurns: boolean) {
    try {
      return await this.codex.readThread(threadId, { includeTurns });
    } catch (error) {
      if (includeTurns && this.isTurnsUnavailableError(error)) {
        return this.codex.readThread(threadId, { includeTurns: false });
      }
      throw error;
    }
  }

  private isTurnsUnavailableError(error: unknown) {
    return error instanceof Error && error.message.includes("includeTurns is unavailable before first user message");
  }

  private repoIdForPath(rootPath: string, override?: RepoConfig) {
    return override?.id ?? `repo_${createHash("sha1").update(rootPath).digest("hex").slice(0, 12)}`;
  }

  private async resolveRepo(cwd: string, fallbackBranch?: string) {
    const cached = this.repoRootCache.get(cwd);
    if (cached) {
      return cached;
    }

    const promise = (async () => {
      let rootPath = cwd;
      try {
        const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
        rootPath = stdout.trim() || cwd;
      } catch {
        rootPath = cwd;
      }

      let branch = fallbackBranch ?? undefined;
      try {
        const { stdout } = await execFileAsync("git", ["-C", rootPath, "branch", "--show-current"]);
        const current = stdout.trim();
        if (current) {
          branch = current;
        }
      } catch {
        // noop
      }

      return { rootPath, branch };
    })();

    this.repoRootCache.set(cwd, promise);
    return promise;
  }

  private async readBranch(repoPath: string) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", repoPath, "branch", "--show-current"]);
      const branch = stdout.trim();
      return branch || undefined;
    } catch {
      return undefined;
    }
  }

  private toIso(value: number) {
    return new Date(value * 1000).toISOString();
  }
}
