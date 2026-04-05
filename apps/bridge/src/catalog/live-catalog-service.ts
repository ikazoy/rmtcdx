import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type {
  Repository,
  Run,
  SessionDetail,
  SessionFilter,
  SessionStatusConfidence,
  SessionStatusReasonCode,
  SessionSummary
} from "@codex-remote/shared-types";
import type { RepoConfig } from "../config/repos";
import { findLatestUserMessagePreview, mapThreadToMessages } from "../codex/parsers/thread-items";
import { CodexThreadObservationStore } from "../codex/thread-observation-store";
import type { CodexBackend, CodexThread, CodexThreadTurn } from "../codex/types";
import { ImageUploadService } from "../uploads/image-upload-service";
import { createIsolatedGitEnv } from "../utils/git-env";
import { excerpt } from "../utils/text";

const execFileAsync = promisify(execFile);

type ThreadContext = {
  thread: CodexThread;
  repo: Repository;
  isArchived: boolean;
};

type DerivedRunState = {
  status: Run["status"];
  reasonCode: SessionStatusReasonCode;
  confidence: SessionStatusConfidence;
};

type DerivedSessionState = {
  status: SessionSummary["status"];
  reasonCode: SessionStatusReasonCode;
  confidence: SessionStatusConfidence;
};

export class LiveCatalogService {
  private readonly repoRootCache = new Map<
    string,
    Promise<{ rootPath: string; branch?: string; canonicalRepoPath?: string }>
  >();
  private readonly repoOverrideByPath: Map<string, RepoConfig>;
  private readonly threadCache = new Map<string, CodexThread>();

  constructor(
    private readonly codex: CodexBackend,
    repoOverrides: RepoConfig[],
    private readonly uploads: ImageUploadService,
    private readonly threadObservations = new CodexThreadObservationStore()
  ) {
    this.repoOverrideByPath = new Map(
      repoOverrides.map((repo) => [this.normalizeLookupPath(repo.path), repo] satisfies readonly [string, RepoConfig])
    );
  }

  async listRepos() {
    const [threads, archivedThreads] = await Promise.all([
      this.codex.listThreads({ archived: false }),
      this.codex.listThreads({ archived: true })
    ]);
    const contexts = [
      ...(await this.enrichThreads(threads, false)),
      ...(await this.enrichThreads(archivedThreads, true))
    ];
    const grouped = new Map<string, { repo: Repository; threads: ThreadContext[] }>();

    for (const context of contexts) {
      const entry = grouped.get(context.repo.id);
      if (entry) {
        entry.threads.push(context);
        entry.repo.updatedAt =
          new Date(context.repo.updatedAt) > new Date(entry.repo.updatedAt)
            ? context.repo.updatedAt
            : entry.repo.updatedAt;
        entry.repo.runningSessionCount += !context.isArchived && context.thread.status.type === "active" ? 1 : 0;
      } else {
        grouped.set(context.repo.id, {
          repo: {
            ...context.repo,
            runningSessionCount: !context.isArchived && context.thread.status.type === "active" ? 1 : 0
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

  async listSessions(repoId?: string, options?: { search?: string; filter?: SessionFilter; hydrateAll?: boolean }) {
    const search = options?.search?.trim();
    const archived = options?.filter === "archived";
    const threads = await this.codex.listThreads({
      archived,
      searchTerm: search || undefined
    });
    const contexts = await this.enrichThreads(threads, archived);
    const hydratedContexts = await this.hydrateSessionContexts(contexts, {
      filter: options?.filter,
      search: search || undefined
    });

    return hydratedContexts
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
    const context = await this.enrichThread(thread, await this.isThreadArchived(thread.id, thread.cwd));
    const derivedRuns = this.deriveRuns(thread);

    return {
      session: this.mapThreadSummary(context),
      activeRun: runOverride?.activeRun ?? derivedRuns.activeRun,
      latestRun: runOverride?.latestRun ?? derivedRuns.latestRun,
      runSettings: null,
      latestTurnHasAssistantOutput: this.latestTurnHasAssistantOutput(thread)
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

  async restoreSession(sessionId: string) {
    await this.readThreadWithFallback(sessionId, false);
    await this.codex.unarchiveThread(sessionId);
    return this.getSessionDetail(sessionId);
  }

  async getThread(sessionId: string) {
    return this.readThreadWithFallback(sessionId, false);
  }

  private matchesFilter(session: SessionSummary, filter?: SessionFilter) {
    if (!filter || filter === "all") {
      return true;
    }
    if (filter === "unread") {
      return session.hasUnreadCompletion || session.hasUnreadError;
    }
    if (filter === "archived") {
      return session.isArchived;
    }
    return session.status === filter;
  }

  private matchesSearch(session: SessionSummary, search?: string) {
    if (!search) {
      return true;
    }

    return session.title.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  }

  private async enrichThreads(threads: CodexThread[], isArchived: boolean) {
    return Promise.all(threads.map((thread) => this.enrichThread(thread, isArchived)));
  }

  private async enrichThread(thread: CodexThread, isArchived: boolean): Promise<ThreadContext> {
    const repoResolution = await this.resolveRepo(thread.cwd, thread.gitInfo?.branch ?? undefined);
    const exactOverride = this.repoOverrideByPath.get(this.normalizeLookupPath(repoResolution.rootPath));
    const inheritedOverride =
      repoResolution.canonicalRepoPath && repoResolution.canonicalRepoPath !== repoResolution.rootPath
        ? this.repoOverrideByPath.get(this.normalizeLookupPath(repoResolution.canonicalRepoPath))
        : undefined;
    const override = exactOverride ?? inheritedOverride;
    const repoId = this.repoIdForPath(repoResolution.rootPath, exactOverride);
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
      },
      isArchived
    };
  }

  private async hydrateSessionContexts(
    contexts: ThreadContext[],
    options?: { filter?: SessionFilter; search?: string; hydrateAll?: boolean }
  ) {
    const hydratedById = new Map<string, ThreadContext>();

    for (const context of contexts) {
      const cached = this.cachedThreadForSummary(context.thread);
      if (cached) {
        hydratedById.set(context.thread.id, {
          ...context,
          thread: cached
        });
      }
    }

    const unresolved = contexts
      .filter((context) => !hydratedById.has(context.thread.id))
      .filter((context) => this.shouldHydrateSummary(context.thread))
      .sort((left, right) => right.thread.updatedAt - left.thread.updatedAt);

    const shouldHydrateAll =
      Boolean(options?.search)
      || Boolean(options?.hydrateAll)
      || (options?.filter !== undefined && options.filter !== "all");
    const maxHydrations = shouldHydrateAll ? unresolved.length : Math.min(unresolved.length, 24);
    const batchSize = shouldHydrateAll ? 12 : 6;

    for (let index = 0; index < maxHydrations; index += batchSize) {
      const batch = unresolved.slice(index, index + batchSize);
      const hydrated = await Promise.all(
        batch.map(async (context) => {
          try {
            const thread = await this.readThreadWithFallback(context.thread.id, true);
            return {
              ...context,
              thread
            } satisfies ThreadContext;
          } catch {
            return context;
          }
        })
      );

      for (const context of hydrated) {
        hydratedById.set(context.thread.id, context);
      }
    }

    return contexts.map((context) => hydratedById.get(context.thread.id) ?? context);
  }

  private shouldHydrateSummary(thread: CodexThread) {
    return thread.status.type === "notLoaded" && thread.turns.length === 0;
  }

  private cachedThreadForSummary(thread: CodexThread) {
    const cached = this.threadCache.get(thread.id);
    if (!cached) {
      return null;
    }

    if (cached.updatedAt < thread.updatedAt) {
      return null;
    }

    return this.shouldHydrateSummary(cached) ? null : this.threadObservations.materializeThread(cached);
  }

  private rememberThread(thread: CodexThread) {
    const current = this.threadCache.get(thread.id);
    if (!current) {
      this.threadCache.set(thread.id, thread);
      return thread;
    }

    const shouldReplace =
      thread.updatedAt > current.updatedAt
      || (thread.updatedAt === current.updatedAt && current.turns.length === 0 && thread.turns.length > 0)
      || (current.status.type === "notLoaded" && thread.status.type !== "notLoaded");

    if (shouldReplace) {
      this.threadCache.set(thread.id, thread);
      return thread;
    }

    return current;
  }

  private mapThreadSummary(context: ThreadContext): SessionSummary {
    const title = this.threadTitle(context.thread, context.repo.name);
    const summary = context.thread.preview.trim()
      ? excerpt(context.thread.preview, 140)
      : `Start a conversation in ${context.repo.name}`;
    const latestUserPrompt = findLatestUserMessagePreview(context.thread, this.uploads)
      ?? (context.thread.preview.trim() || undefined);
    const sessionState = this.deriveThreadSessionState(context.thread);
    const latestTurn = context.thread.turns.at(-1);
    const updatedAt = this.toIso(context.thread.updatedAt);
    const createdAt = this.toIso(context.thread.createdAt);

    return {
      id: context.thread.id,
      repoId: context.repo.id,
      repoName: context.repo.name,
      title,
      summary,
      codexThreadId: context.thread.id,
      status: sessionState.status,
      isArchived: context.isArchived,
      unreadCount: 0,
      lastEventSeq: 0,
      lastReadEventSeq: 0,
      lastMessageAt: updatedAt,
      lastRunFinishedAt: sessionState.status === "running" ? undefined : updatedAt,
      statusReasonCode: sessionState.reasonCode,
      statusConfidence: sessionState.confidence,
      latestTurnId: latestTurn?.id ?? null,
      latestTurnStatus: latestTurn?.status ?? null,
      threadStatusType: context.thread.status.type,
      latestUserPrompt,
      latestAssistantExcerpt: undefined,
      pendingRequestCount: 0,
      hasUnreadCompletion: false,
      hasUnreadError: false,
      createdAt,
      updatedAt
    };
  }

  private async isThreadArchived(threadId: string, cwd: string) {
    const activeThreads = await this.codex.listThreads({ archived: false, cwd });
    if (activeThreads.some((thread) => thread.id === threadId)) {
      return false;
    }

    const archivedThreads = await this.codex.listThreads({ archived: true, cwd });
    return archivedThreads.some((thread) => thread.id === threadId);
  }

  private mapMessages(thread: CodexThread) {
    return mapThreadToMessages(thread, {
      uploads: this.uploads
    });
  }

  private deriveRuns(thread: CodexThread) {
    const latestTurn = thread.turns.at(-1);
    if (!latestTurn) {
      return {
        activeRun: null,
        latestRun: null
      };
    }

    const runState = this.deriveTurnRunState(thread, latestTurn);
    const run: Run = {
      id: latestTurn.id,
      sessionId: thread.id,
      turnId: latestTurn.id,
      status: runState.status,
      startedAt: this.toIso(thread.updatedAt),
      finishedAt: runState.status === "running" ? undefined : this.toIso(thread.updatedAt),
      errorMessage: latestTurn.error?.message ?? undefined
    };

    return {
      activeRun: run.status === "running" ? run : null,
      latestRun: run
    };
  }

  private deriveTurnRunState(thread: CodexThread, turn: CodexThreadTurn): DerivedRunState {
    switch (turn.status) {
      case "completed":
        return {
          status: "completed",
          reasonCode: "latest_turn_completed",
          confidence: "authoritative"
        };
      case "interrupted":
        return {
          status: "interrupted",
          reasonCode: "latest_turn_interrupted",
          confidence: "authoritative"
        };
      case "failed":
        return {
          status: "error",
          reasonCode: "latest_turn_failed",
          confidence: "authoritative"
        };
      default:
        if (thread.status.type === "active") {
          return {
            status: "running",
            reasonCode: "thread_active",
            confidence: "authoritative"
          };
        }

        // This is a heuristic. Another Codex client may still own the active turn.
        return {
          status: "interrupted",
          reasonCode: "in_progress_but_thread_inactive",
          confidence: "suspicious"
        };
    }
  }

  private deriveThreadSessionState(thread: CodexThread): DerivedSessionState {
    const latestTurn = thread.turns.at(-1);
    if (thread.status.type === "active") {
      return {
        status: "running",
        reasonCode: "thread_active",
        confidence: "authoritative"
      };
    }
    if (thread.status.type === "systemError") {
      return {
        status: "error",
        reasonCode: "thread_system_error",
        confidence: "authoritative"
      };
    }
    if (latestTurn) {
      const latestRunState = this.deriveTurnRunState(thread, latestTurn);
      if (latestRunState.status === "error") {
        return {
          status: "error",
          reasonCode: latestRunState.reasonCode,
          confidence: latestRunState.confidence
        };
      }
      if (latestRunState.status === "interrupted") {
        return {
          status: "interrupted",
          reasonCode: latestRunState.reasonCode,
          confidence: latestRunState.confidence
        };
      }
      if (latestRunState.status === "completed") {
        return {
          status: "completed",
          reasonCode: latestRunState.reasonCode,
          confidence: latestRunState.confidence
        };
      }
    }
    if (!thread.preview.trim() && !thread.name) {
      return {
        status: "idle",
        reasonCode: "empty_thread",
        confidence: "authoritative"
      };
    }
    return {
      status: "completed",
      reasonCode: "history_present",
      confidence: "derived"
    };
  }

  private latestTurnHasAssistantOutput(thread: CodexThread) {
    const latestTurn = thread.turns.at(-1);
    if (!latestTurn) {
      return false;
    }

    return latestTurn.items.some((item) => {
      if (item.type !== "agentMessage" || !("phase" in item) || !("text" in item)) {
        return false;
      }

      return item.phase !== "commentary" && item.text.trim().length > 0;
    });
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
      return this.threadObservations.materializeThread(
        this.rememberThread(await this.codex.readThread(threadId, { includeTurns }))
      );
    } catch (error) {
      if (this.isThreadNotLoadedError(error)) {
        const resumed = await this.resumeArchivedThread(threadId, includeTurns);
        if (resumed) {
          return resumed;
        }
      }
      if (includeTurns && this.isTurnsUnavailableError(error)) {
        return this.threadObservations.materializeThread(
          this.rememberThread(await this.codex.readThread(threadId, { includeTurns: false }))
        );
      }
      throw error;
    }
  }

  private async resumeArchivedThread(threadId: string, includeTurns: boolean) {
    const archivedThread = await this.findArchivedThread(threadId);
    if (!archivedThread?.path) {
      return null;
    }

    await this.codex.ensureThread({
      threadId,
      cwd: archivedThread.cwd,
      path: archivedThread.path
    });

    try {
      return this.threadObservations.materializeThread(
        this.rememberThread(await this.codex.readThread(threadId, { includeTurns }))
      );
    } catch (error) {
      if (includeTurns && this.isTurnsUnavailableError(error)) {
        return this.threadObservations.materializeThread(
          this.rememberThread(await this.codex.readThread(threadId, { includeTurns: false }))
        );
      }
      throw error;
    }
  }

  private async findArchivedThread(threadId: string) {
    const archivedThreads = await this.codex.listThreads({ archived: true });
    return archivedThreads.find((thread) => thread.id === threadId) ?? null;
  }

  private isTurnsUnavailableError(error: unknown) {
    return error instanceof Error && error.message.includes("includeTurns is unavailable before first user message");
  }

  private isThreadNotLoadedError(error: unknown) {
    return error instanceof Error && error.message.includes("thread not loaded:");
  }

  private repoIdForPath(rootPath: string, override?: RepoConfig) {
    return override?.id ?? `repo_${createHash("sha1").update(rootPath).digest("hex").slice(0, 12)}`;
  }

  private normalizeLookupPath(candidate: string) {
    try {
      return fs.realpathSync.native(candidate);
    } catch {
      return path.resolve(candidate);
    }
  }

  private async resolveRepo(cwd: string, fallbackBranch?: string) {
    const cached = this.repoRootCache.get(cwd);
    if (cached) {
      return cached;
    }

    const promise = (async () => {
      let rootPath = cwd;
      try {
        const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
          env: createIsolatedGitEnv()
        });
        rootPath = stdout.trim() || cwd;
      } catch {
        rootPath = cwd;
      }

      let branch = fallbackBranch ?? undefined;
      try {
        const { stdout } = await execFileAsync("git", ["-C", rootPath, "branch", "--show-current"], {
          env: createIsolatedGitEnv()
        });
        const current = stdout.trim();
        if (current) {
          branch = current;
        }
      } catch {
        // noop
      }

      let canonicalRepoPath: string | undefined;
      try {
        const { stdout } = await execFileAsync("git", ["-C", rootPath, "rev-parse", "--git-common-dir"], {
          env: createIsolatedGitEnv()
        });
        const commonGitDirRaw = stdout.trim();
        if (commonGitDirRaw) {
          const commonGitDir = path.isAbsolute(commonGitDirRaw)
            ? commonGitDirRaw
            : path.resolve(rootPath, commonGitDirRaw);
          canonicalRepoPath = path.dirname(commonGitDir);
        }
      } catch {
        // noop
      }

      return { rootPath, branch, canonicalRepoPath };
    })();

    this.repoRootCache.set(cwd, promise);
    return promise;
  }

  private async readBranch(repoPath: string) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", repoPath, "branch", "--show-current"], {
        env: createIsolatedGitEnv()
      });
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
