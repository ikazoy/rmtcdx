import { FloatingPortal } from "@floating-ui/react";
import { Children, isValidElement, memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  ChangeEvent,
  ClipboardEvent,
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject
} from "react";
import ReactMarkdown from "react-markdown";
import remend from "remend";
import remarkGfm from "remark-gfm";

import type {
  CodexAvailableModel,
  CodexApprovalPolicyPreset,
  CodexDevRequestScenario,
  CodexRunSettings,
  CodexSandboxPreset,
  FileChangeEntry,
  LiveActivity,
  Message,
  MessageAttachment,
  Repository,
  SessionFilePreviewRequest,
  SessionFilePreviewResponse,
  SessionDetail
} from "@codex-remote/shared-types";
import type { ChatViewState as ChatScreenViewState } from "../../app/view-state";
import { api } from "../../api/client";
import { formatRelativeTime } from "../../components/formatters";
import { moveActiveItemKey, resolveActiveItemKey } from "../../components/listbox-navigation";
import { useAnchoredMenu } from "../../hooks/use-anchored-menu";
import {
  buildRepoNameFormatter,
  sortReposForDisplay
} from "../repos/repo-presentation";
import {
  CUSTOM_MODEL_OPTION,
  DEFAULT_MODEL_OPTION,
} from "./model-selection";
import { useModelSelectionControl } from "./use-model-selection-control";
import {
  collectThreadFileChanges,
  type ThreadFileChangeEntry,
  type ThreadFileChangeSummary
} from "./thread-file-changes";
import { MermaidBlock } from "./MermaidBlock";
import {
  nextTimelineFollowMode,
  shouldAutoScrollTimelineUpdate,
  timelineContentExpanded,
  type TimelineFollowMode
} from "./scroll-follow-state";
import { inferSyntaxLanguageFromPath, SyntaxCodeBlock, syntaxLanguageFromMarkdownClassName } from "./SyntaxCodeBlock";
import { WorkspaceCombobox } from "../repos/WorkspaceCombobox";
import { sessionIndicatorTone } from "../sessions/session-state";
import type { ResolvedRunSettings } from "./run-settings";
import { activityMapForSessionIds, streamingTextForSessionIds, useUiStore } from "../../store/ui-store";

const MAX_IMAGE_ATTACHMENTS = 5;
const TIMELINE_PIN_THRESHOLD_MIN_PX = 120;
const TIMELINE_PIN_THRESHOLD_MAX_PX = 220;
const TIMELINE_PIN_THRESHOLD_VIEWPORT_RATIO = 0.18;
const ACTIVE_COMPOSER_PLACEHOLDER = "Ask Codex...";
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_ACTIVITY_MAP: Record<string, LiveActivity> = {};

function debugChatState(label: string, payload: Record<string, unknown>) {
  if (import.meta.env.DEV) {
    console.info(`[chat-debug] ${label}`, payload);
  }
}

function timelinePinThresholdPx() {
  if (typeof window === "undefined") {
    return TIMELINE_PIN_THRESHOLD_MIN_PX;
  }

  return Math.min(
    TIMELINE_PIN_THRESHOLD_MAX_PX,
    Math.max(TIMELINE_PIN_THRESHOLD_MIN_PX, Math.round(window.innerHeight * TIMELINE_PIN_THRESHOLD_VIEWPORT_RATIO))
  );
}

type OptimisticUserMessage = {
  prompt: string;
  attachments: MessageAttachment[];
};

type ComposerImage = {
  id: string;
  file: File;
  previewUrl: string;
};

function createComposerImages(files: File[]) {
  return files.map((file) => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    file,
    previewUrl: URL.createObjectURL(file)
  }));
}

function clipboardImageFiles(clipboardData: DataTransfer | null) {
  if (!clipboardData) {
    return [];
  }

  const fromItems = Array.from(clipboardData.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);

  if (fromItems.length > 0) {
    return fromItems;
  }

  return Array.from(clipboardData.files).filter((file) => file.type.startsWith("image/"));
}

type MiddleTruncateProps = {
  text: string;
  className?: string;
  suffixLength?: number;
  as?: "span" | "code";
};

function MiddleTruncate({ text, className, suffixLength = 12, as = "span" }: MiddleTruncateProps) {
  const Component = as;
  const suffix = text.length > suffixLength ? text.slice(-suffixLength) : "";
  const prefix = suffix ? text.slice(0, -suffixLength) : text;
  const mergedClassName = className ? `middle-truncate ${className}` : "middle-truncate";

  return (
    <Component className={mergedClassName} title={text}>
      <span className="middle-truncate__start">{prefix}</span>
      {suffix ? <span className="middle-truncate__end">{suffix}</span> : null}
    </Component>
  );
}

type CommandExecutionEntry = {
  id: string;
  message: Message;
  command: string;
  cwd: string;
  output: string | null;
  exitCode: number | null;
  durationMs: number | null;
  status?: string;
  createdAt: string;
};

type SearchQueryEntry = {
  id: string;
  message: Message;
  query: string;
  createdAt: string;
};

type TimelineEntry =
  | { type: "message"; id: string; message: Message }
  | { type: "command_group"; id: string; commands: CommandExecutionEntry[]; createdAt: string }
  | { type: "file_group"; id: string; source: ThreadFileChangeSummary; createdAt: string }
  | { type: "search_group"; id: string; searches: SearchQueryEntry[]; createdAt: string };

type FileChangeListContent = {
  source: ThreadFileChangeSummary;
  title?: string;
};

type FileChangeSheetState = {
  type: "file_list";
  content: FileChangeListContent;
};

type FilePreviewSheetState = {
  type: "file_preview";
  request: SessionFilePreviewRequest;
  sourceList: FileChangeListContent | null;
  selectedIndex: number | null;
};

type BottomSheetState =
  | null
  | { type: "command_list"; commands: CommandExecutionEntry[] }
  | { type: "command_detail"; commands: CommandExecutionEntry[]; selectedIndex: number }
  | FileChangeSheetState
  | FilePreviewSheetState
  | { type: "search_list"; searches: SearchQueryEntry[] };

type ImageViewerState =
  | null
  | {
      attachments: MessageAttachment[];
      selectedIndex: number;
    };

type Props = {
  viewState: ChatScreenViewState;
  sessionIds: readonly string[];
  isMobileViewport: boolean;
  optimisticMessage?: OptimisticUserMessage | null;
  pendingCodexRequestCount: number;
  runSettings: ResolvedRunSettings;
  availableModels: CodexAvailableModel[];
  isLoadingModels: boolean;
  modelsError: string | null;
  devSimulatorAvailable: boolean;
  hasPendingResponse: boolean;
  canInterruptRun: boolean;
  draftRepoPicker:
    | {
        repos: Repository[];
        selectedRepoId: string;
        onSelectRepo: (repoId: string) => void;
      }
    | null;
  onBack: () => void;
  onSubmit: (payload: { prompt: string; files: File[] }) => Promise<void>;
  onRunSettingsChange: (settings: CodexRunSettings) => void;
  onResetRunSettings: () => void;
  onSimulateCodexRequest: (scenario: CodexDevRequestScenario) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onRename: () => Promise<void>;
  onArchive: () => Promise<void>;
  onRestore: () => Promise<void>;
  isSubmitting: boolean;
  isInterrupting: boolean;
  isRenaming: boolean;
  isArchiving: boolean;
  isRestoring: boolean;
  isSimulatingCodexRequest: boolean;
  simulateCodexRequestError: string | null;
  canRename: boolean;
  canArchive: boolean;
  canRestore: boolean;
};

const APPROVAL_POLICY_OPTIONS: Array<{
  value: CodexApprovalPolicyPreset;
  label: string;
  description: string;
}> = [
  {
    value: "on-request",
    label: "On request",
    description: "Ask before actions that need approval."
  },
  {
    value: "on-failure",
    label: "On failure",
    description: "Try first, then ask only if the assistant cannot finish within current permissions."
  },
  {
    value: "untrusted",
    label: "Untrusted",
    description: "Treat the workspace as untrusted and require tighter approval boundaries."
  },
  {
    value: "never",
    label: "Never",
    description: "Do not ask. The assistant must stay within the granted sandbox or fail."
  }
];

const SANDBOX_OPTIONS: Array<{ value: CodexSandboxPreset; label: string }> = [
  { value: "workspace-write", label: "Workspace write" },
  { value: "read-only", label: "Read only" },
  { value: "danger-full-access", label: "Danger full access" }
];

const DEV_REQUEST_OPTIONS: Array<{ value: CodexDevRequestScenario; label: string }> = [
  { value: "command_approval", label: "Simulate command approval" },
  { value: "file_change_approval", label: "Simulate file change approval" },
  { value: "permissions_approval", label: "Simulate permissions approval" },
  { value: "request_user_input", label: "Simulate input request" },
  { value: "mcp_elicitation", label: "Simulate MCP confirmation" }
];

function timelineIsPinnedToBottom(timeline: HTMLDivElement) {
  return timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop <= timelinePinThresholdPx();
}

function revokeComposerImages(images: ComposerImage[]) {
  for (const image of images) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

function revokeOptimisticAttachments(message: OptimisticUserMessage | null) {
  for (const attachment of message?.attachments ?? []) {
    if (attachment.url.startsWith("blob:")) {
      URL.revokeObjectURL(attachment.url);
    }
  }
}

function optimisticMessageFromComposer(prompt: string, images: ComposerImage[]): OptimisticUserMessage {
  return {
    prompt,
    attachments: images.map((image) => ({
      kind: "image",
      name: image.file.name || "image",
      url: image.previewUrl
    }))
  };
}

function messageMatchesOptimistic(message: Message, optimistic: OptimisticUserMessage) {
  if (message.role !== "user" || message.text.trim() !== optimistic.prompt.trim()) {
    return false;
  }

  const actualNames = (message.attachments ?? []).map((attachment) => attachment.name.trim().toLowerCase()).sort();
  const optimisticNames = optimistic.attachments.map((attachment) => attachment.name.trim().toLowerCase()).sort();

  return (
    actualNames.length === optimisticNames.length &&
    actualNames.every((name, index) => name === optimisticNames[index])
  );
}

function messagePresentation(message: Message) {
  switch (message.kind) {
    case "user_message":
      return { rowRole: "user", tone: "user" };
    case "assistant_thinking":
      return { rowRole: "assistant", tone: "thinking" };
    case "plan":
      return { rowRole: "assistant", tone: "thinking" };
    case "reasoning":
      return { rowRole: "assistant", tone: "thinking" };
    case "mcp_tool_call":
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return { rowRole: "system", tone: "tool" };
    case "web_search":
      return { rowRole: "system", tone: "search" };
    case "image_view":
    case "image_generation":
      return { rowRole: "system", tone: "artifact" };
    case "review_mode_entered":
    case "review_mode_exited":
      return { rowRole: "system", tone: "review" };
    case "context_compaction":
      return { rowRole: "system", tone: "note" };
    case "run_error":
      return { rowRole: "system", tone: "error" };
    case "assistant_message":
    default:
      return { rowRole: "assistant", tone: "assistant" };
  }
}

function extractFencedBlock(text: string, language: string) {
  const match = new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\\n\`\`\``).exec(text);
  return match?.[1]?.trim() ?? "";
}

function parseExitCode(text: string) {
  const match = /Exit code:\s*(-?\d+)/.exec(text);
  return match ? Number(match[1]) : null;
}

function commandExecutionFromMessage(message: Message): CommandExecutionEntry {
  if (message.metadata?.type === "command_execution") {
    return {
      id: message.id,
      message,
      command: message.metadata.command,
      cwd: message.metadata.cwd,
      output: message.metadata.output,
      exitCode: message.metadata.exitCode,
      durationMs: message.metadata.durationMs ?? null,
      status: message.status,
      createdAt: message.createdAt
    };
  }

  const command = extractFencedBlock(message.text, "sh") || "shell command";
  const output = extractFencedBlock(message.text, "text") || null;

  return {
    id: message.id,
    message,
    command,
    cwd: "",
    output,
    exitCode: parseExitCode(message.text),
    durationMs: null,
    status: message.status,
    createdAt: message.createdAt
  };
}

function searchQueryFromMessage(message: Message) {
  if (message.metadata?.type === "web_search") {
    return message.metadata.query.trim();
  }

  return message.text.replace(/^Query:\s*/i, "").trim() || message.text.trim();
}

function fileChangeSummaryDetail(change: ThreadFileChangeEntry) {
  const displayPath = displayPathForPreview(change);
  const details: string[] = [];

  if (change.firstPath !== displayPath) {
    details.push(`From ${change.firstPath}`);
  }

  if (change.occurrenceCount > 1) {
    details.push(formatCountLabel(change.occurrenceCount, "edit"));
  }

  return details.length > 0 ? details.join(" · ") : null;
}

function formatFileChangeSheetSubtitle(source: ThreadFileChangeSummary) {
  if (source.rawCount === source.count) {
    return "Tap a file to open diff / source.";
  }

  return `${formatCountLabel(source.rawCount, "change")} across ${formatCountLabel(source.count, "file")} · tap a file for diff / source`;
}

function filePreviewRequestFromChange(change: ThreadFileChangeEntry): SessionFilePreviewRequest {
  return {
    path: change.path,
    diff: change.diff ?? null,
    changeKind: change.kind,
    movePath: change.movePath ?? null
  };
}

function findThreadFileChangeIndex(content: FileChangeListContent, href: string) {
  const normalizedHref = href.replace(/^\.\//, "");

  return content.source.changes.findIndex((change) => {
    const displayPath = displayPathForPreview(change);
    return normalizedHref === change.path || normalizedHref === displayPath || normalizedHref === change.movePath;
  });
}

function buildTimelineEntries(messages: Message[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;

    if (message.kind === "command_execution") {
      const commandMessages: Message[] = [message];

      while (index + 1 < messages.length && messages[index + 1]?.kind === "command_execution") {
        commandMessages.push(messages[index + 1]!);
        index += 1;
      }

      const commands = commandMessages.map((item) => commandExecutionFromMessage(item));
      entries.push({
        type: "command_group",
        id: `command-group:${commandMessages[0]!.id}`,
        commands,
        createdAt: commandMessages[commandMessages.length - 1]!.createdAt
      });
      continue;
    }

    if (message.kind === "file_change") {
      const fileMessages: Message[] = [message];

      while (index + 1 < messages.length && messages[index + 1]?.kind === "file_change") {
        fileMessages.push(messages[index + 1]!);
        index += 1;
      }

      const source = collectThreadFileChanges(fileMessages);

      if (source) {
        entries.push({
          type: "file_group",
          id: `file-group:${fileMessages[0]!.id}`,
          source,
          createdAt: fileMessages[fileMessages.length - 1]!.createdAt
        });
      }
      continue;
    }

    if (message.kind === "web_search") {
      const searchMessages: Message[] = [message];

      while (index + 1 < messages.length && messages[index + 1]?.kind === "web_search") {
        searchMessages.push(messages[index + 1]!);
        index += 1;
      }

      const searches = searchMessages.map((item) => ({
        id: item.id,
        message: item,
        query: searchQueryFromMessage(item),
        createdAt: item.createdAt
      }));

      entries.push({
        type: "search_group",
        id: `search-group:${searchMessages[0]!.id}`,
        searches,
        createdAt: searchMessages[searchMessages.length - 1]!.createdAt
      });
      continue;
    }

    entries.push({
      type: "message",
      id: message.id,
      message
    });
  }

  return entries;
}

function formatCountLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatCommandGroupTitle(count: number) {
  return `Ran ${formatCountLabel(count, "command")}`;
}

function formatFileGroupTitle(count: number) {
  return `Edited ${formatCountLabel(count, "file")}`;
}

function formatThreadDiffTitle(count: number) {
  return count > 0 ? `Thread diff · ${formatCountLabel(count, "file")}` : "Thread diff";
}

function formatCompactThreadDiffCount(count: number) {
  return count > 99 ? "99+" : String(count);
}

function formatSearchGroupTitle(count: number) {
  return `Ran ${formatCountLabel(count, "search", "searches")}`;
}

function commandStatusLabel(command: CommandExecutionEntry) {
  switch (command.status) {
    case "completed":
      return command.exitCode === null || command.exitCode === 0 ? "Completed" : `Exit ${command.exitCode}`;
    case "failed":
      return command.exitCode !== null ? `Failed · exit ${command.exitCode}` : "Failed";
    case "inProgress":
      return "Running";
    case "declined":
      return "Declined";
    default:
      return command.exitCode !== null ? `Exit ${command.exitCode}` : "Bash";
  }
}

function formatDuration(durationMs: number | null) {
  if (durationMs === null || Number.isNaN(durationMs)) {
    return null;
  }
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(durationMs >= 10000 ? 0 : 1)}s`;
  }
  return `${Math.round(durationMs)}ms`;
}

function formatLatestTurnStatusDebug(detail: SessionDetail) {
  if (detail.session.latestTurnStatus === undefined) {
    return "missing";
  }

  return detail.session.latestTurnStatus ?? "none";
}

function formatThreadStatusTypeDebug(detail: SessionDetail) {
  return detail.session.threadStatusType ?? "missing";
}

function formatStatusReasonDebug(detail: SessionDetail) {
  return detail.session.statusReasonCode ?? "missing";
}

function formatStatusConfidenceDebug(detail: SessionDetail) {
  return detail.session.statusConfidence ?? "missing";
}

async function copyTextToClipboard(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard is unavailable");
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "true");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function fileChangeVerb(change: FileChangeEntry) {
  switch (change.kind) {
    case "add":
      return "Add";
    case "delete":
      return "Delete";
    case "update":
    default:
      return change.movePath ? "Move" : "Edit";
  }
}

function displayPathForPreview(preview: Pick<SessionFilePreviewRequest, "path" | "movePath">) {
  return preview.movePath ?? preview.path;
}

function fileLeafName(candidate: string) {
  const parts = candidate.split(/[\\/]/);
  return parts[parts.length - 1] || candidate;
}

function looksLikeMarkdownPath(candidate: string) {
  const normalized = candidate.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  const leaf = fileLeafName(normalized).toLowerCase();
  return normalized.endsWith(".md") || normalized.endsWith(".mdx") || normalized.endsWith(".markdown") || leaf === "readme";
}

function isLikelyLocalFileHref(href: string) {
  if (!href || href.startsWith("#")) {
    return false;
  }

  if (href.startsWith("file://")) {
    return true;
  }

  if (/^(https?:|mailto:|tel:)/i.test(href)) {
    return false;
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)) {
    return false;
  }

  if (href.startsWith("/") || href.startsWith("./") || href.startsWith("../")) {
    return true;
  }

  return href.includes("/") || /\.[a-z0-9]+([?#].*)?$/i.test(href) || /^readme([?#].*)?$/i.test(href);
}

function defaultFilePreviewTab(request: Pick<SessionFilePreviewRequest, "path" | "movePath" | "diff">) {
  if (request.diff?.trim()) {
    return "diff" as const;
  }

  if (looksLikeMarkdownPath(displayPathForPreview(request))) {
    return "preview" as const;
  }
  return "source" as const;
}

function filePreviewEmptyMessage(preview: SessionFilePreviewResponse) {
  switch (preview.contentStatus) {
    case "missing":
      return preview.diff?.trim()
        ? "This file is no longer present on disk. The recorded diff is still available."
        : "This file is no longer present on disk.";
    case "directory":
      return "This path resolves to a directory, so file preview is not available.";
    case "binary":
      return preview.diff?.trim()
        ? "Binary file preview is not available here. The recorded diff is still available."
        : "Binary file preview is not available here.";
    case "too_large":
      return preview.diff?.trim()
        ? "This file is larger than the preview limit. The recorded diff is still available."
        : "This file is larger than the preview limit.";
    case "ok":
    default:
      return "No preview data is available for this file.";
  }
}

function filePreviewHasImage(preview: SessionFilePreviewResponse | null) {
  return Boolean(preview?.imageDataUrl && preview.mediaType?.startsWith("image/"));
}

function flattenNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((child) => flattenNodeText(child)).join("");
  }

  return "";
}

function markdownCodeBlockFromPre(children: ReactNode) {
  const [child] = Children.toArray(children);
  if (!child || !isValidElement(child)) {
    return null;
  }

  const props = child.props as {
    className?: string;
    children?: ReactNode;
  };
  const className = typeof props.className === "string" ? props.className : "";
  const code = flattenNodeText(props.children ?? "").replace(/\n$/, "");
  if (!code) {
    return null;
  }

  return {
    code,
    language: syntaxLanguageFromMarkdownClassName(className)
  };
}

function mermaidCodeFromMarkdownPre(children: ReactNode) {
  const codeBlock = markdownCodeBlockFromPre(children);
  return codeBlock?.language === "mermaid" ? codeBlock.code : null;
}

const MessageBody = memo(function MessageBody({
  text,
  repairIncompleteMarkdown = false,
  allowMermaid = true,
  onOpenFileLink
}: {
  text: string;
  repairIncompleteMarkdown?: boolean;
  allowMermaid?: boolean;
  onOpenFileLink?: (href: string) => void;
}) {
  const markdown = repairIncompleteMarkdown ? remend(text, { linkMode: "text-only" }) : text;

  return (
    <div className="message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ children, href, node: _node, ...props }) {
            const isExternalHref = typeof href === "string" && /^(https?:|mailto:|tel:)/i.test(href);
            const shouldHandleInApp = typeof href === "string" && Boolean(onOpenFileLink) && isLikelyLocalFileHref(href);

            return (
              <a
                {...props}
                href={href}
                target={isExternalHref ? "_blank" : undefined}
                rel={isExternalHref ? "noreferrer" : undefined}
                onClick={(event) => {
                  if (shouldHandleInApp && href) {
                    event.preventDefault();
                    onOpenFileLink?.(href);
                  }
                }}
              >
                {children}
              </a>
            );
          },
          pre({ children, node: _node, ...props }) {
            const codeBlock = markdownCodeBlockFromPre(children);
            const mermaidCode = allowMermaid ? mermaidCodeFromMarkdownPre(children) : null;

            if (mermaidCode !== null) {
              return <MermaidBlock code={mermaidCode} />;
            }

            if (codeBlock) {
              return <SyntaxCodeBlock code={codeBlock.code} language={codeBlock.language} className="message-code-block" />;
            }

            return <pre {...props}>{children}</pre>;
          }
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
});

const StreamingTextBody = memo(function StreamingTextBody({ text }: { text: string }) {
  return <div className="message-markdown message-markdown--streaming-plain">{text}</div>;
});

const MessageAttachments = memo(function MessageAttachments({
  attachments,
  onOpen
}: {
  attachments: MessageAttachment[];
  onOpen: (attachments: MessageAttachment[], selectedIndex: number) => void;
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="message-attachments">
      <span className="message-attachments__label">
        {attachments.length} image{attachments.length === 1 ? "" : "s"} attached
      </span>
      {attachments.map((attachment, index) => (
        <button
          key={`${attachment.url}:${index}`}
          className="message-attachment"
          type="button"
          onClick={() => onOpen(attachments, index)}
          aria-label={`Open ${attachment.name}`}
        >
          <img src={attachment.url} alt={attachment.name} loading="lazy" />
        </button>
      ))}
    </div>
  );
});

function SheetBackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15.5 5.5 9 12l6.5 6.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

function SheetUpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 17.5V6.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M7.5 11 12 6.5 16.5 11" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function SheetDownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 6.5v11" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M7.5 13 12 17.5 16.5 13" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function SheetCloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6 18 18M18 6 6 18" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 6.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="m8 10 2.5 2L8 14.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
      <path d="M12.5 14.5h3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3.5h6l4 4v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M13 3.5v4h4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="m9 15.5 5-5 1.5 1.5-5 5H9z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.3" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="m15 15 4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </svg>
  );
}

function CustomSelect({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string; description?: string }>;
  onChange: (value: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeOptionValue, setActiveOptionValue] = useState<string | null>(value);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const listboxId = useId();
  const selectableOptions = options.map((option) => ({
    key: option.value,
    label: option.label,
    description: option.description,
    isSelected: option.value === value
  }));
  const activeOption = selectableOptions.find((opt) => opt.isSelected) ?? selectableOptions[0] ?? null;
  const highlightedOption =
    selectableOptions.find((opt) => opt.key === activeOptionValue) ?? activeOption;

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setActiveOptionValue(value);
      return;
    }

    setActiveOptionValue((current) =>
      resolveActiveItemKey({
        items: selectableOptions,
        currentKey: current,
        preferredKey: activeOption?.key ?? null
      })
    );
  }, [activeOption?.key, isOpen, selectableOptions, value]);

  useEffect(() => {
    if (!isOpen || !highlightedOption) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const node = optionRefs.current.get(highlightedOption.key);
      node?.focus();
      node?.scrollIntoView({
        block: "nearest"
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [highlightedOption, isOpen]);

  function closeMenu(restoreFocus = false) {
    setIsOpen(false);
    if (restoreFocus) {
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    }
  }

  function selectOption(nextValue: string) {
    onChange(nextValue);
    closeMenu(true);
  }

  function moveActive(delta: -1 | 1) {
    setActiveOptionValue((current) =>
      moveActiveItemKey({
        items: selectableOptions,
        currentKey: current ?? activeOption?.key ?? null,
        delta
      })
    );
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        return;
      }

      moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      closeMenu();
    }
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveActive(-1);
        break;
      case "Home":
        event.preventDefault();
        setActiveOptionValue(selectableOptions[0]?.key ?? null);
        break;
      case "End":
        event.preventDefault();
        setActiveOptionValue(selectableOptions.at(-1)?.key ?? null);
        break;
      case "Enter":
      case " ":
        if (highlightedOption) {
          event.preventDefault();
          selectOption(highlightedOption.key);
        }
        break;
      case "Escape":
        event.preventDefault();
        closeMenu(true);
        break;
      default:
        break;
    }
  }

  return (
    <div className="custom-select" ref={containerRef}>
      <span className="custom-select__label">{label}</span>
      <button
        ref={triggerRef}
        className="custom-select__trigger"
        type="button"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="custom-select__trigger-value">{activeOption?.label ?? value}</span>
        <svg className="custom-select__chevron" viewBox="0 0 16 16" fill="none">
          <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {isOpen ? (
        <div className="custom-select__menu" id={listboxId} role="listbox">
          {selectableOptions.map((opt) => (
            <button
              key={opt.key}
              ref={(node) => {
                if (node) {
                  optionRefs.current.set(opt.key, node);
                  return;
                }

                optionRefs.current.delete(opt.key);
              }}
              className={`custom-select__option ${opt.isSelected ? "is-active" : ""} ${highlightedOption?.key === opt.key ? "is-highlighted" : ""}`.trim()}
              role="option"
              aria-selected={opt.isSelected}
              tabIndex={highlightedOption?.key === opt.key ? 0 : -1}
              onFocus={() => setActiveOptionValue(opt.key)}
              onMouseEnter={() => setActiveOptionValue(opt.key)}
              onKeyDown={handleOptionKeyDown}
              onClick={() => {
                selectOption(opt.key);
              }}
              type="button"
            >
              <span className="custom-select__option-content">
                <span className="custom-select__option-label">{opt.label}</span>
                {opt.description ? (
                  <span className="custom-select__option-desc">{opt.description}</span>
                ) : null}
              </span>
              <span className="custom-select__option-check">
                <svg viewBox="0 0 16 16" fill="none" width="16" height="16">
                  <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RunSettingsPanel({
  availableModels,
  isLoadingModels,
  modelsError,
  runSettings,
  onRunSettingsChange,
  onResetRunSettings
}: {
  availableModels: CodexAvailableModel[];
  isLoadingModels: boolean;
  modelsError: string | null;
  runSettings: ResolvedRunSettings;
  onRunSettingsChange: (settings: CodexRunSettings) => void;
  onResetRunSettings: () => void;
}) {
  const {
    defaultModelLabel,
    defaultModelDescription,
    modelSelectionOptions,
    modelSelectionValue,
    modelFieldNote,
    showModelPicker,
    showCustomModelInput,
    resetModelSelectionState,
    onModelSelectionChange,
    onCustomModelInputChange
  } = useModelSelectionControl({
    availableModels,
    runSettings,
    onRunSettingsChange
  });

  return (
    <section className="sidebar-menu__section">
      <p className="sidebar-menu__section-title">Run settings</p>
      <div className="chat-head__settings-form">
        <CustomSelect
          label="Approval policy"
          value={runSettings.approvalPolicy}
          options={APPROVAL_POLICY_OPTIONS.map((opt) => ({
            value: opt.value,
            label: opt.label,
            description: opt.description
          }))}
          onChange={(value) =>
            onRunSettingsChange({
              ...runSettings,
              approvalPolicy: value as CodexApprovalPolicyPreset
            })
          }
        />

        <CustomSelect
          label="Sandbox"
          value={runSettings.sandbox}
          options={SANDBOX_OPTIONS.map((opt) => ({
            value: opt.value,
            label: opt.label
          }))}
          onChange={(value) =>
            onRunSettingsChange({
              ...runSettings,
              sandbox: value as CodexSandboxPreset
            })
          }
        />

        {showModelPicker ? (
          <CustomSelect
            label="Model"
            value={modelSelectionValue}
            options={[
              { value: DEFAULT_MODEL_OPTION, label: defaultModelLabel, description: defaultModelDescription },
              ...modelSelectionOptions.map((opt) => ({
                value: opt.value,
                label: opt.label,
                description: opt.description
              })),
              { value: CUSTOM_MODEL_OPTION, label: "Custom model ID" }
            ]}
            onChange={onModelSelectionChange}
          />
        ) : null}

        {showCustomModelInput ? (
          <label className="chat-head__settings-field">
            <span>{showModelPicker ? "Custom model ID" : "Model ID"}</span>
            <input
              type="text"
              value={runSettings.model}
              onChange={(event) => onCustomModelInputChange(event.target.value)}
              placeholder="gpt-5.4-mini"
            />
          </label>
        ) : null}

        <p className="chat-head__settings-hint">{modelFieldNote}</p>
        {isLoadingModels ? <p className="chat-head__settings-hint">Loading model list…</p> : null}
        {modelsError ? (
          <p className="chat-head__settings-error">
            Unable to load models. You can still enter a custom model id.
          </p>
        ) : null}

        <button
          className="settings-reset"
          onClick={() => {
            resetModelSelectionState();
            onResetRunSettings();
          }}
          type="button"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 2V6H6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><path d="M2.5 10A6 6 0 1 0 4 4.5L2 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Reset to defaults
        </button>
        <p className="settings-note">Applies to the next run for this thread.</p>
      </div>
    </section>
  );
}

function MoreActionsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="12" r="1.8" fill="currentColor" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      <circle cx="18" cy="12" r="1.8" fill="currentColor" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="8" width="10" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5 6.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 16V8A1.5 1.5 0 0 1 5 6.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <circle cx="9" cy="10" r="1.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="m7 16 3.4-3.6a1 1 0 0 1 1.46-.02L14 14.5l1.47-1.58a1 1 0 0 1 1.45-.03L19 15.1"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

type SummaryCardTone = "command" | "file" | "search";

type SummaryCardProps = {
  tone: SummaryCardTone;
  title: string;
  rows: Array<{
    id: string;
    prefix: string;
    text: string;
    detail?: string | null;
  }>;
  extraCount: number;
  onClick: () => void;
};

function SummaryCardToneIcon({ tone }: { tone: SummaryCardTone }) {
  if (tone === "command") {
    return <TerminalIcon />;
  }
  if (tone === "file") {
    return <FileIcon />;
  }
  return <SearchIcon />;
}

const SummaryCard = memo(function SummaryCard({
  tone,
  title,
  rows,
  extraCount,
  onClick
}: SummaryCardProps) {
  return (
    <article className="message-row message-row--system">
      <button className={`summary-card summary-card--${tone}`} type="button" onClick={onClick}>
        <header className="summary-card__head">
          <div className="summary-card__title-wrap">
            <strong>{title}</strong>
            <span className="summary-card__chevron">›</span>
          </div>
        </header>
        <div className="summary-card__list">
          {rows.map((row) => (
            <div key={row.id} className="summary-card__row">
              <span className={`summary-card__icon summary-card__icon--${tone}`}>
                <SummaryCardToneIcon tone={tone} />
              </span>
              <div className="summary-card__row-copy">
                <span className="summary-card__row-line">
                  <span className="summary-card__row-prefix">{row.prefix}</span>
                  {tone === "file" ? (
                    <MiddleTruncate className="summary-card__row-text" suffixLength={18} text={row.text} />
                  ) : (
                    <span className="summary-card__row-text">{row.text}</span>
                  )}
                </span>
                {row.detail ? (
                  tone === "file" ? (
                    <MiddleTruncate className="summary-card__row-detail" suffixLength={18} text={row.detail} />
                  ) : (
                    <span className="summary-card__row-detail">{row.detail}</span>
                  )
                ) : null}
              </div>
            </div>
          ))}
        </div>
        {extraCount > 0 ? <div className="summary-card__more">+{extraCount}</div> : null}
      </button>
    </article>
  );
});

const ThreadDiffEntry = memo(function ThreadDiffEntry({
  count,
  onOpen
}: {
  count: number;
  onOpen: () => void;
}) {
  return (
    <button
      className="thread-diff-entry"
      type="button"
      onClick={onOpen}
      aria-label={`Open thread diff. ${formatCountLabel(count, "file")} changed.`}
      title={formatThreadDiffTitle(count)}
    >
      <span className="thread-diff-entry__label">Diff</span>
      <span className="thread-diff-entry__count">{formatCompactThreadDiffCount(count)}</span>
    </button>
  );
});

const ActivityTray = memo(function ActivityTray({ activities }: { activities: LiveActivity[] }) {
  if (activities.length === 0) {
    return null;
  }

  const commandCount = activities.filter((activity) => activity.kind === "command").length;
  const headline =
    commandCount > 0
      ? `${commandCount} terminal${commandCount === 1 ? "" : "s"} running`
      : `${activities.length} task${activities.length === 1 ? "" : "s"} running`;

  return (
    <section className="activity-tray">
      <header className="activity-tray__head">
        <strong>{headline}</strong>
      </header>
      <div className="activity-tray__list">
        {activities.map((activity) => (
          <article key={activity.itemId} className={`activity-row activity-row--${activity.kind}`}>
            <div className="activity-row__meta">
              <span className="activity-row__label">{activity.kind}</span>
              <span className="activity-row__time">{formatRelativeTime(activity.updatedAt)}</span>
            </div>
            <div className="activity-row__title">{activity.label}</div>
            {activity.output ? <pre className="activity-row__output">{activity.output.trimEnd()}</pre> : null}
          </article>
        ))}
      </div>
    </section>
  );
});

function BottomSheet({
  title,
  subtitle,
  onClose,
  onBack,
  backAriaLabel,
  headerActions,
  showCloseButton = true,
  children
}: {
  title: string;
  subtitle?: string | null;
  onClose: () => void;
  onBack?: () => void;
  backAriaLabel?: string;
  headerActions?: ReactNode;
  showCloseButton?: boolean;
  children: ReactNode;
}) {
  const [dragOffset, setDragOffset] = useState(0);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);

  function handleDragStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    const target = event.target;
    if (target instanceof HTMLElement && target.closest("button, a, input, textarea, select")) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false
    };
  }

  function handleDragMove(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;

    if (!dragState.dragging) {
      if (deltaY <= 0 || Math.abs(deltaY) < 8 || Math.abs(deltaY) < Math.abs(deltaX)) {
        return;
      }

      dragState.dragging = true;
    }

    event.preventDefault();
    setDragOffset(Math.max(0, deltaY));
  }

  function finishDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const deltaY = Math.max(0, event.clientY - dragState.startY);
    const shouldClose = dragState.dragging && deltaY > 96;

    dragStateRef.current = null;

    if (shouldClose) {
      onClose();
      return;
    }

    setDragOffset(0);
  }

  function cancelDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    dragStateRef.current = null;
    setDragOffset(0);
  }

  return (
    <div className="bottom-sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        aria-label={title}
        aria-modal="true"
        className={`bottom-sheet${dragOffset > 0 ? " bottom-sheet--dragging" : ""}`}
        role="dialog"
        style={
          dragOffset > 0
            ? {
                transform: `translateY(${dragOffset}px)`,
                opacity: Math.max(0.88, 1 - dragOffset / 480)
              }
            : undefined
        }
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="bottom-sheet__drag-zone"
          onPointerCancel={cancelDrag}
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={finishDrag}
        >
          <div className="bottom-sheet__handle" />
          <header className="bottom-sheet__header">
            <div className="bottom-sheet__side">
              {onBack ? (
                <button className="bottom-sheet__icon-button" type="button" aria-label={backAriaLabel ?? "Back"} onClick={onBack}>
                  <SheetBackIcon />
                </button>
              ) : null}
            </div>
            <div className="bottom-sheet__headline">
              <strong>{title}</strong>
              {subtitle ? <span>{subtitle}</span> : null}
            </div>
            <div className="bottom-sheet__side bottom-sheet__side--end">
              {headerActions ? <div className="bottom-sheet__actions">{headerActions}</div> : null}
              {showCloseButton ? (
                <button className="bottom-sheet__icon-button" type="button" aria-label="Close" onClick={onClose}>
                  <SheetCloseIcon />
                </button>
              ) : null}
            </div>
          </header>
        </div>
        <div className="bottom-sheet__body">{children}</div>
      </section>
    </div>
  );
}

function ImageViewer({
  attachments,
  selectedIndex,
  onSelect,
  onClose
}: {
  attachments: MessageAttachment[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onClose: () => void;
}) {
  const attachment = attachments[selectedIndex];
  if (!attachment) {
    return null;
  }

  const canGoPrev = selectedIndex > 0;
  const canGoNext = selectedIndex < attachments.length - 1;

  return (
    <div className="image-viewer-backdrop" role="presentation" onClick={onClose}>
      <section
        className="image-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={attachment.name}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="image-viewer__header">
          <div className="image-viewer__headline">
            <strong>{attachment.name}</strong>
            <span>
              {selectedIndex + 1} / {attachments.length}
            </span>
          </div>
          <button className="image-viewer__icon-button" type="button" aria-label="Close" onClick={onClose}>
            <SheetCloseIcon />
          </button>
        </header>

        <div className="image-viewer__body">
          {canGoPrev ? (
            <button
              className="image-viewer__nav"
              type="button"
              aria-label="Previous image"
              onClick={() => onSelect(selectedIndex - 1)}
            >
              <SheetBackIcon />
            </button>
          ) : null}

          <div className="image-viewer__viewport">
            <img src={attachment.url} alt={attachment.name} />
          </div>

          {canGoNext ? (
            <button
              className="image-viewer__nav image-viewer__nav--next"
              type="button"
              aria-label="Next image"
              onClick={() => onSelect(selectedIndex + 1)}
            >
              <SheetBackIcon />
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function CommandListSheet({
  commands,
  onClose,
  onSelect
}: {
  commands: CommandExecutionEntry[];
  onClose: () => void;
  onSelect: (index: number) => void;
}) {
  return (
    <BottomSheet title={formatCommandGroupTitle(commands.length)} onClose={onClose}>
      <div className="sheet-list">
        {commands.map((command, index) => (
          <button
            key={command.id}
            className="sheet-row sheet-row--button sheet-row--command"
            type="button"
            onClick={() => onSelect(index)}
          >
            <span className="sheet-row__icon sheet-row__icon--command">
              <TerminalIcon />
            </span>
            <div className="sheet-row__copy">
              <span className="sheet-row__eyebrow">Bash</span>
              <span className="sheet-row__title">{command.command}</span>
              <span className="sheet-row__meta">
                {commandStatusLabel(command)}
                {command.cwd ? ` · ${command.cwd}` : ""}
              </span>
            </div>
          </button>
        ))}
      </div>
    </BottomSheet>
  );
}

function CommandDetailSheet({
  commands,
  selectedIndex,
  onClose,
  onBack
}: {
  commands: CommandExecutionEntry[];
  selectedIndex: number;
  onClose: () => void;
  onBack: () => void;
}) {
  const command = commands[selectedIndex];
  if (!command) {
    return null;
  }

  const duration = formatDuration(command.durationMs);

  return (
    <BottomSheet title="Bash" subtitle={commandStatusLabel(command)} onClose={onClose} onBack={onBack}>
      <div className="sheet-meta">
        {duration ? <span className="sheet-meta__badge">{duration}</span> : null}
        {command.exitCode !== null ? <span className="sheet-meta__badge">exit {command.exitCode}</span> : null}
        {command.cwd ? <span className="sheet-meta__badge">{command.cwd}</span> : null}
      </div>

      <section className="sheet-terminal-block">
        <span className="sheet-terminal-block__label">Command</span>
        <pre>{command.command}</pre>
      </section>

      <section className="sheet-terminal-block">
        <span className="sheet-terminal-block__label">Output</span>
        <pre>{command.output?.trim() || "No output."}</pre>
      </section>
    </BottomSheet>
  );
}

function FileChangeSheet({
  content,
  title,
  onClose,
  onSelect
}: {
  content: FileChangeListContent;
  title?: string;
  onClose: () => void;
  onSelect: (change: ThreadFileChangeEntry, index: number) => void;
}) {
  const { source } = content;
  return (
    <BottomSheet title={title ?? formatFileGroupTitle(source.count)} subtitle={formatFileChangeSheetSubtitle(source)} onClose={onClose}>
      <div className="sheet-list">
        {source.changes.length > 0 ? (
          source.changes.map((change, index) => {
            const detail = fileChangeSummaryDetail(change);

            return (
              <button
                key={change.movePath ?? change.path}
                className="sheet-row sheet-row--button"
                type="button"
                onClick={() => onSelect(change, index)}
              >
                <span className="sheet-row__icon sheet-row__icon--file">
                  <FileIcon />
                </span>
                <div className="sheet-row__copy">
                  <span className="sheet-row__title">
                    <span className="sheet-row__eyebrow sheet-row__eyebrow--inline">{fileChangeVerb(change)}</span>
                    <MiddleTruncate className="sheet-row__title-text" suffixLength={18} text={displayPathForPreview(change)} />
                  </span>
                  {detail ? <MiddleTruncate className="sheet-row__meta" suffixLength={18} text={detail} /> : null}
                </div>
              </button>
            );
          })
        ) : (
          <p className="sheet-empty">No file details were recorded for this run.</p>
        )}
      </div>
    </BottomSheet>
  );
}

function FilePreviewSheet({
  sessionId,
  request,
  sourceList,
  selectedIndex,
  isMobileViewport,
  onClose,
  onBack,
  onNavigateFile,
  onOpenFileLink
}: {
  sessionId: string;
  request: SessionFilePreviewRequest;
  sourceList: FileChangeListContent | null;
  selectedIndex: number | null;
  isMobileViewport: boolean;
  onClose: () => void;
  onBack?: () => void;
  onNavigateFile: (delta: number) => void;
  onOpenFileLink: (href: string) => void;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [response, setResponse] = useState<SessionFilePreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"preview" | "source" | "diff">(() => defaultFilePreviewTab(request));

  useEffect(() => {
    setActiveTab(defaultFilePreviewTab(request));
  }, [request]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setResponse(null);
    setError(null);

    void api
      .filePreview(sessionId, request)
      .then((next) => {
        if (cancelled) {
          return;
        }
        setResponse(next);
        setStatus("ready");
      })
      .catch((nextError) => {
        if (cancelled) {
          return;
        }
        setStatus("error");
        setError(nextError instanceof Error ? nextError.message : "Unable to load file preview.");
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, request]);

  const preview = response ?? null;
  const displayPath = displayPathForPreview(preview ?? request);
  const title = fileLeafName(displayPath) || "File";
  const fullPath = preview?.resolvedPath ?? displayPath;
  const hasPreviewTab = preview?.contentStatus === "ok" && preview.isMarkdown;
  const hasImageSource = filePreviewHasImage(preview);
  const hasSourceTab = preview?.contentStatus === "ok" && (preview.text !== null || hasImageSource);
  const hasDiffTab = Boolean(preview?.diff?.trim());
  const sourceCount = sourceList?.source.count ?? 0;
  const currentIndex = selectedIndex ?? -1;
  const hasThreadNavigation = currentIndex >= 0 && sourceCount > 1;
  const canGoPrev = hasThreadNavigation && currentIndex > 0;
  const canGoNext = hasThreadNavigation && currentIndex < sourceCount - 1;
  const sourceLanguage = inferSyntaxLanguageFromPath(displayPath);
  const availableTabs = [
    ...(hasDiffTab ? (["diff"] as const) : []),
    ...(hasPreviewTab ? (["preview"] as const) : []),
    ...(hasSourceTab ? (["source"] as const) : [])
  ];
  const selectedTab = availableTabs.includes(activeTab) ? activeTab : (availableTabs[0] ?? null);
  const headerActions = hasThreadNavigation ? (
    <>
      <button
        className="bottom-sheet__icon-button bottom-sheet__icon-button--nav bottom-sheet__icon-button--prev"
        type="button"
        aria-label="Previous file"
        disabled={!canGoPrev}
        onClick={() => onNavigateFile(-1)}
      >
        <SheetUpIcon />
      </button>
      <button
        className="bottom-sheet__icon-button bottom-sheet__icon-button--nav bottom-sheet__icon-button--next"
        type="button"
        aria-label="Next file"
        disabled={!canGoNext}
        onClick={() => onNavigateFile(1)}
      >
        <SheetDownIcon />
      </button>
    </>
  ) : null;

  return (
    <BottomSheet
      title={title}
      subtitle={null}
      onClose={onClose}
      onBack={onBack}
      backAriaLabel="Back to list"
      headerActions={headerActions}
      showCloseButton={!isMobileViewport}
    >
      {status === "loading" ? <p className="sheet-empty">Loading file preview…</p> : null}
      {status === "error" ? <p className="sheet-empty">{error ?? "Unable to load file preview."}</p> : null}

      <p className="file-preview__path" title={fullPath}>
        {fullPath}
      </p>

      {preview ? (
        <>
          {availableTabs.length > 0 ? (
            <div className="file-preview__tabs" role="tablist" aria-label="File preview tabs">
              {hasDiffTab ? (
                <button
                  className={`file-preview__tab${selectedTab === "diff" ? " is-active" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={selectedTab === "diff"}
                  onClick={() => setActiveTab("diff")}
                >
                  Diff
                </button>
              ) : null}
              {hasPreviewTab ? (
                <button
                  className={`file-preview__tab${selectedTab === "preview" ? " is-active" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={selectedTab === "preview"}
                  onClick={() => setActiveTab("preview")}
                >
                  Preview
                </button>
              ) : null}
              {hasSourceTab ? (
                <button
                  className={`file-preview__tab${selectedTab === "source" ? " is-active" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={selectedTab === "source"}
                  onClick={() => setActiveTab("source")}
                >
                  Source
                </button>
              ) : null}
            </div>
          ) : null}

          {selectedTab === "preview" && preview.text !== null ? (
            <div className="file-preview__panel">
              <MessageBody text={preview.text} onOpenFileLink={onOpenFileLink} />
            </div>
          ) : null}

          {selectedTab === "source" && preview ? (
            <section className="file-preview__panel">
              {hasImageSource ? (
                <figure className="file-preview__image-frame">
                  <img className="file-preview__image" src={preview.imageDataUrl!} alt={title} />
                </figure>
              ) : preview.text !== null ? (
                <SyntaxCodeBlock code={preview.text} language={sourceLanguage} className="file-preview__code" />
              ) : null}
            </section>
          ) : null}

          {selectedTab === "diff" && preview ? (
            <section className="file-preview__panel">
              {hasImageSource ? (
                <figure className="file-preview__image-frame file-preview__image-frame--diff">
                  <img className="file-preview__image" src={preview.imageDataUrl!} alt={title} />
                  <figcaption>Current image snapshot</figcaption>
                </figure>
              ) : null}
              {preview.diff ? (
                <SyntaxCodeBlock code={preview.diff} language="diff" className="file-preview__code" />
              ) : null}
            </section>
          ) : null}

          {!selectedTab ? <p className="sheet-empty">{filePreviewEmptyMessage(preview)}</p> : null}
        </>
      ) : null}
    </BottomSheet>
  );
}

function SearchListSheet({
  searches,
  onClose
}: {
  searches: SearchQueryEntry[];
  onClose: () => void;
}) {
  return (
    <BottomSheet title={formatSearchGroupTitle(searches.length)} onClose={onClose}>
      <div className="sheet-list">
        {searches.map((search) => (
          <div key={search.id} className="sheet-row">
            <span className="sheet-row__icon sheet-row__icon--search">
              <SearchIcon />
            </span>
            <div className="sheet-row__copy">
              <span className="sheet-row__eyebrow">Query</span>
              <span className="sheet-row__title">{search.query}</span>
              <span className="sheet-row__meta">{formatRelativeTime(search.createdAt)}</span>
            </div>
          </div>
        ))}
      </div>
    </BottomSheet>
  );
}

const ConversationTimeline = memo(function ConversationTimeline({
  messages,
  messagesError,
  isLoadingMessages,
  streamingText,
  liveActivities,
  optimisticMessage,
  showPendingAssistant,
  timelineRef,
  timelineEndRef,
  showJumpToLatest,
  hasQueuedUpdates,
  onJumpToLatest,
  onOpenCommands,
  onOpenFileChanges,
  onOpenFileLink,
  onOpenSearches,
  onOpenImageViewer
}: {
  messages: Message[];
  messagesError: string | null;
  isLoadingMessages: boolean;
  streamingText: string;
  liveActivities: LiveActivity[];
  optimisticMessage?: OptimisticUserMessage | null;
  showPendingAssistant: boolean;
  timelineRef: RefObject<HTMLDivElement | null>;
  timelineEndRef: RefObject<HTMLDivElement | null>;
  showJumpToLatest: boolean;
  hasQueuedUpdates: boolean;
  onJumpToLatest: () => void;
  onOpenCommands: (commands: CommandExecutionEntry[]) => void;
  onOpenFileChanges: (content: FileChangeListContent) => void;
  onOpenFileLink: (href: string) => void;
  onOpenSearches: (searches: SearchQueryEntry[]) => void;
  onOpenImageViewer: (attachments: MessageAttachment[], selectedIndex: number) => void;
}) {
  const entries = buildTimelineEntries(messages);
  const hasConfirmedOptimistic =
    Boolean(optimisticMessage) &&
    messages.some((message) => optimisticMessage ? messageMatchesOptimistic(message, optimisticMessage) : false);
  const showTimelineError =
    Boolean(messagesError) && messages.length === 0 && !isLoadingMessages && !streamingText && !optimisticMessage && !showPendingAssistant;
  const showTimelineSkeleton =
    isLoadingMessages && messages.length === 0 && !streamingText && !optimisticMessage && !showPendingAssistant;

  return (
    <div className="timeline-shell">
      <div ref={timelineRef} className="timeline-wrap">
        <div className="timeline">
          <ActivityTray activities={liveActivities} />

          {entries.map((entry) => {
            if (entry.type === "command_group") {
              const previewRows = entry.commands.slice(0, 3).map((command) => ({
                id: command.id,
                prefix: "Bash",
                text: command.command
              }));

              return (
                <SummaryCard
                  key={entry.id}
                  tone="command"
                  title={formatCommandGroupTitle(entry.commands.length)}
                  rows={previewRows}
                  extraCount={Math.max(0, entry.commands.length - previewRows.length)}
                  onClick={() => onOpenCommands(entry.commands)}
                />
              );
            }

            if (entry.type === "file_group") {
              const previewRows = entry.source.changes.slice(0, 5).map((change) => ({
                id: change.movePath ?? change.path,
                prefix: fileChangeVerb(change),
                text: displayPathForPreview(change),
                detail: fileChangeSummaryDetail(change)
              }));

              return (
                <SummaryCard
                  key={entry.id}
                  tone="file"
                  title={formatFileGroupTitle(entry.source.count)}
                  rows={previewRows}
                  extraCount={Math.max(0, entry.source.count - previewRows.length)}
                  onClick={() => onOpenFileChanges({ source: entry.source, title: formatFileGroupTitle(entry.source.count) })}
                />
              );
            }

            if (entry.type === "search_group") {
              const previewRows = entry.searches.slice(0, 3).map((search) => ({
                id: search.id,
                prefix: "Query",
                text: search.query
              }));

              return (
                <SummaryCard
                  key={entry.id}
                  tone="search"
                  title={formatSearchGroupTitle(entry.searches.length)}
                  rows={previewRows}
                  extraCount={Math.max(0, entry.searches.length - previewRows.length)}
                  onClick={() => onOpenSearches(entry.searches)}
                />
              );
            }

            const { message } = entry;
            const presentation = messagePresentation(message);

            return (
              <article key={message.id} className={`message-row message-row--${presentation.rowRole}`}>
                <div
                  className={[
                    "message-card",
                    `message-card--${presentation.rowRole}`,
                    `message-card--${presentation.tone}`,
                    `message-card--kind-${message.kind}`
                  ].join(" ")}
                  data-kind={message.kind}
                >
                  {message.attachments?.length ? (
                    <MessageAttachments attachments={message.attachments} onOpen={onOpenImageViewer} />
                  ) : null}
                  {message.text ? (
                    <MessageBody
                      text={message.text}
                      repairIncompleteMarkdown={message.role !== "user"}
                      onOpenFileLink={onOpenFileLink}
                    />
                  ) : null}
                </div>
              </article>
            );
          })}

          {optimisticMessage && !hasConfirmedOptimistic ? (
            <article className="message-row message-row--user">
              <div className="message-card message-card--user">
                {optimisticMessage.attachments.length ? (
                  <MessageAttachments attachments={optimisticMessage.attachments} onOpen={onOpenImageViewer} />
                ) : null}
                {optimisticMessage.prompt ? <MessageBody text={optimisticMessage.prompt} onOpenFileLink={onOpenFileLink} /> : null}
              </div>
            </article>
          ) : null}

          {streamingText ? (
            <article className="message-row message-row--assistant">
              <div className="message-card message-card--assistant message-card--thinking message-card--streaming">
                <StreamingTextBody text={streamingText} />
              </div>
            </article>
          ) : null}

          {!streamingText && showPendingAssistant ? (
            <article className="message-row message-row--assistant">
              <div className="message-card message-card--assistant message-card--thinking message-card--pending">
                <p className="thinking-text">Thinking...</p>
              </div>
            </article>
          ) : null}

          {showTimelineSkeleton ? (
            <>
              <div className="skeleton skeleton--message skeleton--message-wide" />
              <div className="skeleton skeleton--message" />
              <div className="skeleton skeleton--message skeleton--message-wide" />
            </>
          ) : null}

          {showTimelineError ? (
            <article className="message-row message-row--system">
              <div className="message-card message-card--system message-card--error">
                <p>Unable to load this thread history.</p>
                <p>{messagesError}</p>
              </div>
            </article>
          ) : null}

          <div ref={timelineEndRef} className="timeline-end" aria-hidden="true" />
        </div>
      </div>

      {showJumpToLatest ? (
        <div className="timeline-jump">
          <button
            className="timeline-jump__button"
            data-has-unseen={hasQueuedUpdates}
            onClick={onJumpToLatest}
            type="button"
          >
            Latest
          </button>
        </div>
      ) : null}
    </div>
  );
});

function ChatSkeletonContent() {
  return (
    <>
      <div className="chat-topbar">
        <div className="chat-head">
          <div>
            <div className="skeleton skeleton--title" />
            <div className="skeleton skeleton--subtitle" />
          </div>
        </div>
      </div>
      <div className="timeline-shell">
        <div className="timeline-wrap">
          <div className="timeline">
            <div className="skeleton skeleton--message skeleton--message-wide" />
            <div className="skeleton skeleton--message" />
            <div className="skeleton skeleton--message skeleton--message-wide" />
          </div>
        </div>
      </div>
      <div className="composer-shell composer-shell--loading" aria-hidden="true">
        <div className="composer composer--loading">
          <div className="composer-field composer-field--loading">
            <div className="skeleton composer-skeleton composer-skeleton--input" />
            <div className="skeleton composer-skeleton composer-skeleton--button" />
          </div>
        </div>
      </div>
    </>
  );
}

export function ChatPane({
  viewState,
  sessionIds,
  isMobileViewport,
  optimisticMessage,
  pendingCodexRequestCount,
  runSettings,
  availableModels,
  isLoadingModels,
  modelsError,
  devSimulatorAvailable,
  hasPendingResponse,
  canInterruptRun,
  draftRepoPicker,
  onBack,
  onSubmit,
  onRunSettingsChange,
  onResetRunSettings,
  onSimulateCodexRequest,
  onInterrupt,
  onRename,
  onArchive,
  onRestore,
  isSubmitting,
  isInterrupting,
  isRenaming,
  isArchiving,
  isRestoring,
  isSimulatingCodexRequest,
  simulateCodexRequestError,
  canRename,
  canArchive,
  canRestore
}: Props) {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectedImagesRef = useRef<ComposerImage[]>([]);
  const followModeRef = useRef<TimelineFollowMode>("following");
  const isPinnedToBottomRef = useRef(true);
  const isProgrammaticScrollRef = useRef(false);
  const lastTimelineScrollTopRef = useRef(0);
  const lastTimelineEndOffsetRef = useRef(0);
  const shouldScrollToBottomRef = useRef(true);
  const touchStartYRef = useRef<number | null>(null);
  const [selectedImages, setSelectedImages] = useState<ComposerImage[]>([]);
  const [localOptimisticMessage, setLocalOptimisticMessage] = useState<OptimisticUserMessage | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sheetState, setSheetState] = useState<BottomSheetState>(null);
  const [imageViewerState, setImageViewerState] = useState<ImageViewerState>(null);
  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);
  const [isDebugOpen, setIsDebugOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [hasQueuedUpdates, setHasQueuedUpdates] = useState(false);
  const [composerShellHeight, setComposerShellHeight] = useState(0);
  const [visualViewportBottomInset, setVisualViewportBottomInset] = useState(0);
  const [copiedDebugField, setCopiedDebugField] = useState<string | null>(null);
  const actionsMenu = useAnchoredMenu({
    open: isActionsMenuOpen,
    onOpenChange: setIsActionsMenuOpen
  });
  const readyView = viewState.kind === "ready" ? viewState : null;
  const streamingText = useUiStore((state) => streamingTextForSessionIds(state.streaming, sessionIds));
  const liveActivityMap = useUiStore((state) => activityMapForSessionIds(state.activities, sessionIds) ?? EMPTY_ACTIVITY_MAP);
  const liveActivities = useMemo(() => Object.values(liveActivityMap), [liveActivityMap]);
  const detail = readyView?.detail ?? null;
  const messages = readyView?.messages ?? EMPTY_MESSAGES;
  const messagesError = readyView?.messagesError ?? null;
  const isLoadingMessages = readyView?.isLoadingMessages ?? false;
  const threadDiffSourceList = collectThreadFileChanges(messages);
  const threadDiffCount = threadDiffSourceList?.count ?? 0;
  const repoName = readyView?.repoName;
  const orderedDraftRepos = draftRepoPicker ? sortReposForDisplay(draftRepoPicker.repos) : [];
  const formatDraftRepoName = draftRepoPicker ? buildRepoNameFormatter(orderedDraftRepos) : null;
  const selectedDraftRepo =
    draftRepoPicker?.repos.find((repo) => repo.id === draftRepoPicker.selectedRepoId) ?? null;
  const showDraftRepoPicker = Boolean(draftRepoPicker && formatDraftRepoName && selectedDraftRepo);
  const draftRepoPickerConfig = showDraftRepoPicker
    ? {
        selectedRepoId: selectedDraftRepo!.id,
        formatRepoLabel: formatDraftRepoName!,
        onSelectRepo: (repoId: string | null) => {
          if (repoId) {
            draftRepoPicker!.onSelectRepo(repoId);
          }
        }
      }
    : null;
  const effectiveOptimisticMessage = optimisticMessage ?? localOptimisticMessage;

  const activeRunState = detail?.activeRun?.status ?? null;
  const latestRunState = detail?.latestRun?.status ?? null;
  const sessionIsArchived = Boolean(detail?.session.isArchived);
  const sessionIsDraft = detail?.session.id.startsWith("draft:") === true;
  const sessionIsRunning = activeRunState === "queued" || activeRunState === "running";
  const hasPendingRun = sessionIsRunning || isSubmitting || Boolean(effectiveOptimisticMessage) || hasPendingResponse;
  const interruptButtonEnabled = canInterruptRun && !isSubmitting;
  const bannerRunState =
    (activeRunState === "queued" ? "running" : activeRunState) ??
    (latestRunState === "error" || latestRunState === "interrupted" ? latestRunState : null);
  const statusLooksSuspicious = detail?.session.statusConfidence === "suspicious";
  const headerSignalTone = detail
    ? sessionIndicatorTone({
        ...detail.session,
        pendingRequestCount: Math.max(detail.session.pendingRequestCount, pendingCodexRequestCount)
      })
    : "none";
  const headerStatusDotTone = bannerRunState ?? (headerSignalTone !== "none" ? headerSignalTone : null);
  const showPendingAssistant =
    !streamingText && (Boolean(effectiveOptimisticMessage) || sessionIsRunning || isSubmitting || hasPendingResponse);
  const showComposerEmptyState =
    !messagesError && !isLoadingMessages && messages.length === 0 && !streamingText && !effectiveOptimisticMessage && !showPendingAssistant;
  const openFilePreview = useCallback(
    (
      request: SessionFilePreviewRequest,
      sourceList: FileChangeListContent | null = null,
      selectedIndex: number | null = null
    ) => {
      setSheetState({
        type: "file_preview",
        request,
        sourceList,
        selectedIndex
      });
    },
    []
  );
  const openFilePreviewFromChange = useCallback(
    (change: ThreadFileChangeEntry, sourceList: FileChangeListContent, selectedIndex: number) => {
      openFilePreview(filePreviewRequestFromChange(change), sourceList, selectedIndex);
    },
    [openFilePreview]
  );
  const openThreadDiff = useCallback(() => {
    if (!threadDiffSourceList) {
      return;
    }

    setSheetState({
      type: "file_list",
      content: {
        source: threadDiffSourceList,
        title: formatThreadDiffTitle(threadDiffSourceList.count)
      }
    });
  }, [threadDiffSourceList]);
  const openFilePreviewFromLink = useCallback(
    (href: string, sourceList: FileChangeListContent | null = null) => {
      if (sourceList) {
        const selectedIndex = findThreadFileChangeIndex(sourceList, href);
        if (selectedIndex >= 0) {
          const change = sourceList.source.changes[selectedIndex];
          if (change) {
            openFilePreviewFromChange(change, sourceList, selectedIndex);
            return;
          }
        }
      }

      openFilePreview({ path: href }, sourceList);
    },
    [openFilePreview, openFilePreviewFromChange]
  );
  const navigateFilePreview = useCallback((delta: number) => {
    setSheetState((current) => {
      if (current?.type !== "file_preview" || !current.sourceList || current.selectedIndex === null) {
        return current;
      }

      const nextIndex = Math.min(
        current.sourceList.source.changes.length - 1,
        Math.max(0, current.selectedIndex + delta)
      );

      if (nextIndex === current.selectedIndex) {
        return current;
      }

      const change = current.sourceList.source.changes[nextIndex];
      if (!change) {
        return current;
      }

      return {
        ...current,
        request: filePreviewRequestFromChange(change),
        selectedIndex: nextIndex
      };
    });
  }, []);

  useEffect(() => {
    debugChatState("render-state", {
      viewKind: viewState.kind,
      detailId: detail?.session.id ?? null,
      messageCount: messages.length,
      optimistic: Boolean(effectiveOptimisticMessage),
      localOptimistic: Boolean(localOptimisticMessage),
      hasPendingResponse,
      streamingTextLength: streamingText.length,
      liveActivityCount: liveActivities.length,
      isLoadingMessages,
      isSubmitting,
      sessionIsRunning,
      showPendingAssistant,
      showComposerEmptyState
    });
  }, [
    detail?.session.id,
    hasPendingResponse,
    isLoadingMessages,
    isSubmitting,
    localOptimisticMessage,
    liveActivities.length,
    messages.length,
    effectiveOptimisticMessage,
    sessionIsRunning,
    showComposerEmptyState,
    showPendingAssistant,
    streamingText.length,
    viewState.kind
  ]);

  useEffect(() => {
    if (!copiedDebugField) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCopiedDebugField(null);
    }, 1600);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [copiedDebugField]);

  const readCurrentScrollTop = useCallback(() => timelineRef.current?.scrollTop ?? 0, []);

  const readTimelineEndOffset = useCallback(() => {
    const timelineEnd = timelineEndRef.current;
    if (!timelineEnd) {
      return 0;
    }

    return timelineEnd.offsetTop + timelineEnd.offsetHeight;
  }, []);

  const disableAutoFollow = useCallback(() => {
    followModeRef.current = "detached";
    shouldScrollToBottomRef.current = false;
  }, []);

  const syncTimelinePinnedState = useCallback((scrollDelta = 0, isProgrammaticScroll = false) => {
    const pinnedToBottom = timelineRef.current ? timelineIsPinnedToBottom(timelineRef.current) : true;
    followModeRef.current = nextTimelineFollowMode({
      currentMode: followModeRef.current,
      pinnedToBottom,
      scrollDelta,
      isProgrammaticScroll
    });

    isPinnedToBottomRef.current = pinnedToBottom;
    setShowJumpToLatest(!pinnedToBottom);

    if (pinnedToBottom) {
      setHasQueuedUpdates(false);
    }
  }, []);

  const scrollTimelineToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const timelineEnd = timelineEndRef.current;
    if (!timelineEnd) {
      return;
    }

    followModeRef.current = "following";
    shouldScrollToBottomRef.current = false;
    isProgrammaticScrollRef.current = true;
    timelineEnd.scrollIntoView({ block: "end", behavior });
    lastTimelineScrollTopRef.current = readCurrentScrollTop();
    lastTimelineEndOffsetRef.current = readTimelineEndOffset();
    isPinnedToBottomRef.current = true;
    setShowJumpToLatest(false);
    setHasQueuedUpdates(false);

    window.requestAnimationFrame(() => {
      isProgrammaticScrollRef.current = false;
      lastTimelineScrollTopRef.current = readCurrentScrollTop();
      lastTimelineEndOffsetRef.current = readTimelineEndOffset();
      syncTimelinePinnedState(0, true);
    });
  }, [readCurrentScrollTop, readTimelineEndOffset, syncTimelinePinnedState]);

  useEffect(() => {
    selectedImagesRef.current = selectedImages;
  }, [selectedImages]);

  useEffect(() => () => revokeComposerImages(selectedImagesRef.current), []);

  useEffect(() => () => revokeOptimisticAttachments(localOptimisticMessage), [localOptimisticMessage]);

  useEffect(() => {
    if (!localOptimisticMessage || !optimisticMessage) {
      return;
    }

    setLocalOptimisticMessage((current) => {
      revokeOptimisticAttachments(current);
      return null;
    });
  }, [localOptimisticMessage, optimisticMessage]);

  useEffect(() => {
    if (!localOptimisticMessage) {
      return;
    }

    const confirmed = messages.some((message) => messageMatchesOptimistic(message, localOptimisticMessage));
    if (!confirmed) {
      return;
    }

    setLocalOptimisticMessage((current) => {
      revokeOptimisticAttachments(current);
      return null;
    });
  }, [localOptimisticMessage, messages]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const viewport = window.visualViewport;
    if (!viewport) {
      setVisualViewportBottomInset(0);
      return;
    }

    const updateVisualViewportBottomInset = () => {
      const bottomInset = Math.max(0, Math.ceil(window.innerHeight - viewport.height - viewport.offsetTop));
      setVisualViewportBottomInset(bottomInset);
    };

    updateVisualViewportBottomInset();
    viewport.addEventListener("resize", updateVisualViewportBottomInset);
    viewport.addEventListener("scroll", updateVisualViewportBottomInset);
    window.addEventListener("resize", updateVisualViewportBottomInset);

    return () => {
      viewport.removeEventListener("resize", updateVisualViewportBottomInset);
      viewport.removeEventListener("scroll", updateVisualViewportBottomInset);
      window.removeEventListener("resize", updateVisualViewportBottomInset);
    };
  }, []);

  useEffect(() => {
    const composerShell = composerShellRef.current;
    if (!composerShell) {
      setComposerShellHeight(0);
      return;
    }

    const updateComposerShellHeight = () => {
      setComposerShellHeight(Math.ceil(composerShell.getBoundingClientRect().height));
    };

    updateComposerShellHeight();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        updateComposerShellHeight();
      });
      observer.observe(composerShell);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", updateComposerShellHeight);
    return () => window.removeEventListener("resize", updateComposerShellHeight);
  }, [detail?.session.id, isMobileViewport]);

  useEffect(() => {
    if (!sheetState && !imageViewerState) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        if (imageViewerState) {
          setImageViewerState(null);
          return;
        }
        setSheetState(null);
        return;
      }

      if (!imageViewerState) {
        if (sheetState?.type !== "file_preview" || !sheetState.sourceList || sheetState.selectedIndex === null) {
          return;
        }
      }

      if (event.key === "ArrowUp") {
        if (!imageViewerState) {
          event.preventDefault();
          navigateFilePreview(-1);
          return;
        }

        event.preventDefault();
        setImageViewerState((current) =>
          current
            ? {
                ...current,
                selectedIndex: Math.max(0, current.selectedIndex - 1)
              }
            : current
        );
      }

      if (event.key === "ArrowDown") {
        if (!imageViewerState) {
          event.preventDefault();
          navigateFilePreview(1);
          return;
        }

        event.preventDefault();
        setImageViewerState((current) =>
          current
            ? {
                ...current,
                selectedIndex: Math.min(current.attachments.length - 1, current.selectedIndex + 1)
              }
            : current
        );
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
    document.body.style.overflow = previousOverflow;
    window.removeEventListener("keydown", handleKeyDown);
  };
  }, [imageViewerState, navigateFilePreview, sheetState]);

  const clearSelectedImages = ({ preservePreviewUrls = false }: { preservePreviewUrls?: boolean } = {}) => {
    setSelectedImages((current) => {
      if (!preservePreviewUrls) {
        revokeComposerImages(current);
      }
      return [];
    });

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  useEffect(() => {
    if (!detail?.session.id) {
      return;
    }

    if (composerRef.current) {
      composerRef.current.value = "";
      composerRef.current.style.height = "auto";
    }
    clearSelectedImages();
    setLocalOptimisticMessage((current) => {
      revokeOptimisticAttachments(current);
      return null;
    });
    setSubmitError(null);
    setSheetState(null);
    setImageViewerState(null);
    setIsActionsMenuOpen(false);
    followModeRef.current = "following";
    isPinnedToBottomRef.current = true;
    isProgrammaticScrollRef.current = false;
    lastTimelineScrollTopRef.current = 0;
    lastTimelineEndOffsetRef.current = 0;
    shouldScrollToBottomRef.current = true;
    touchStartYRef.current = null;
    setShowJumpToLatest(false);
    setHasQueuedUpdates(false);
  }, [detail?.session.id]);

  useEffect(() => {
    if (!showComposerEmptyState || sessionIsArchived || sessionIsDraft) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const composer = composerRef.current;
      if (!composer) {
        return;
      }

      composer.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [detail?.session.id, sessionIsArchived, sessionIsDraft, showComposerEmptyState, showDraftRepoPicker]);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }

    const handleScroll = () => {
      const currentScrollTop = readCurrentScrollTop();
      const scrollDelta = currentScrollTop - lastTimelineScrollTopRef.current;
      const isProgrammaticScroll = isProgrammaticScrollRef.current;

      syncTimelinePinnedState(scrollDelta, isProgrammaticScroll);
      lastTimelineScrollTopRef.current = currentScrollTop;
    };

    handleScroll();
    timeline.addEventListener("scroll", handleScroll, { passive: true });

    const handleWheel = (event: Event) => {
      if (!(event instanceof WheelEvent)) {
        return;
      }

      if (event.deltaY < -1) {
        disableAutoFollow();
      }
    };

    const handleTouchStart = (event: Event) => {
      if (!(event instanceof TouchEvent)) {
        return;
      }

      touchStartYRef.current = event.touches[0]?.clientY ?? null;
    };

    const handleTouchMove = (event: Event) => {
      if (!(event instanceof TouchEvent)) {
        return;
      }

      const currentY = event.touches[0]?.clientY;
      if (touchStartYRef.current === null || typeof currentY !== "number") {
        return;
      }

      if (currentY - touchStartYRef.current > 8) {
        disableAutoFollow();
      }
    };

    const resetTouchTracking = () => {
      touchStartYRef.current = null;
    };

    timeline.addEventListener("wheel", handleWheel, { passive: true });
    timeline.addEventListener("touchstart", handleTouchStart, { passive: true });
    timeline.addEventListener("touchmove", handleTouchMove, { passive: true });
    timeline.addEventListener("touchend", resetTouchTracking, { passive: true });
    timeline.addEventListener("touchcancel", resetTouchTracking, { passive: true });

    return () => {
      timeline.removeEventListener("scroll", handleScroll);
      timeline.removeEventListener("wheel", handleWheel);
      timeline.removeEventListener("touchstart", handleTouchStart);
      timeline.removeEventListener("touchmove", handleTouchMove);
      timeline.removeEventListener("touchend", resetTouchTracking);
      timeline.removeEventListener("touchcancel", resetTouchTracking);
    };
  }, [detail?.session.id, disableAutoFollow, readCurrentScrollTop, syncTimelinePinnedState]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      lastTimelineScrollTopRef.current = readCurrentScrollTop();
      lastTimelineEndOffsetRef.current = readTimelineEndOffset();
      syncTimelinePinnedState(0, isProgrammaticScrollRef.current);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [detail?.session.id, readCurrentScrollTop, readTimelineEndOffset, syncTimelinePinnedState]);

  useEffect(() => {
    if (!timelineEndRef.current) {
      return;
    }

    const nextTimelineEndOffset = readTimelineEndOffset();
    const contentExpanded = timelineContentExpanded(lastTimelineEndOffsetRef.current, nextTimelineEndOffset);
    lastTimelineEndOffsetRef.current = nextTimelineEndOffset;

    if (!shouldAutoScrollTimelineUpdate({
      followMode: followModeRef.current,
      pinnedToBottom: isPinnedToBottomRef.current,
      pendingScrollToBottom: shouldScrollToBottomRef.current,
      contentExpanded
    })) {
      if (followModeRef.current === "detached") {
        setHasQueuedUpdates(true);
      }
      return;
    }

    shouldScrollToBottomRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      scrollTimelineToBottom();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [liveActivities, messages, optimisticMessage, readTimelineEndOffset, scrollTimelineToBottom, showPendingAssistant, streamingText]);

  const handleSubmit = async () => {
    if (hasPendingRun) {
      return;
    }

    if (sessionIsArchived) {
      setSubmitError("Restore this thread before sending a prompt.");
      return;
    }

    const prompt = composerRef.current?.value.trim() ?? "";
    if (!prompt && selectedImages.length === 0) {
      return;
    }

    setSubmitError(null);

    const files = selectedImages.map((image) => image.file);
    const nextLocalOptimisticMessage = optimisticMessageFromComposer(prompt, selectedImages);

    followModeRef.current = "following";
    isPinnedToBottomRef.current = true;
    shouldScrollToBottomRef.current = true;
    setShowJumpToLatest(false);
    setHasQueuedUpdates(false);
    setLocalOptimisticMessage((current) => {
      revokeOptimisticAttachments(current);
      return nextLocalOptimisticMessage;
    });

    if (composerRef.current) {
      composerRef.current.value = "";
      composerRef.current.style.height = "auto";
    }
    clearSelectedImages({ preservePreviewUrls: true });

    try {
      await onSubmit({ prompt, files });
    } catch (error) {
      setLocalOptimisticMessage((current) => {
        revokeOptimisticAttachments(current);
        return null;
      });
      if (composerRef.current) {
        composerRef.current.value = prompt;
        composerRef.current.style.height = "auto";
      }
      setSelectedImages(createComposerImages(files));
      setSubmitError(error instanceof Error ? error.message : "Unable to send this message.");
    }
  };

  const autoResize = () => {
    const textarea = composerRef.current;
    if (!textarea) {
      return;
    }
    setSubmitError(null);
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    if (!(event.metaKey || event.ctrlKey)) {
      return;
    }

    event.preventDefault();
    void handleSubmit();
  };

  const appendSelectedImages = (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    const remainingSlots = Math.max(0, MAX_IMAGE_ATTACHMENTS - selectedImagesRef.current.length);
    if (remainingSlots === 0) {
      setSubmitError(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images per message.`);
      return;
    }

    const acceptedFiles = files.slice(0, remainingSlots);
    if (acceptedFiles.length < files.length) {
      setSubmitError(
        remainingSlots === 1
          ? "Only the first image was added."
          : `Only the first ${remainingSlots} images were added.`
      );
    } else {
      setSubmitError(null);
    }

    const nextImages = createComposerImages(acceptedFiles);
    setSelectedImages((current) => [...current, ...nextImages]);
  };

  const handleImageSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));
    appendSelectedImages(files);
    event.target.value = "";
  };

  const handleComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (isSubmitting) {
      return;
    }

    const files = clipboardImageFiles(event.clipboardData);
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    appendSelectedImages(files);

    const pastedText = event.clipboardData.getData("text/plain");
    if (!pastedText || !composerRef.current) {
      return;
    }

    const { selectionStart, selectionEnd } = composerRef.current;
    composerRef.current.setRangeText(pastedText, selectionStart, selectionEnd, "end");
    autoResize();
  };

  const removeSelectedImage = (imageId: string) => {
    setSubmitError(null);
    setSelectedImages((current) => {
      const nextImages: ComposerImage[] = [];

      for (const image of current) {
        if (image.id === imageId) {
          URL.revokeObjectURL(image.previewUrl);
          continue;
        }
        nextImages.push(image);
      }

      return nextImages;
    });
  };

  const handleCopySessionId = async () => {
    if (!detail) {
      return;
    }

    try {
      await copyTextToClipboard(detail.session.id);
      setCopiedDebugField("session-id");
    } catch {
      setCopiedDebugField(null);
    }
  };

  return (
    <div
      className="chat-card"
      style={
        {
          "--composer-shell-height": `${composerShellHeight}px`,
          "--viewport-bottom-inset": `${visualViewportBottomInset}px`
        } as CSSProperties
      }
    >
      {detail ? (
        <>
          <div className="chat-topbar">
            <div className="chat-head">
              <div className="chat-head__lead">
                <div className="chat-toolbar__left chat-head__nav">
                  <button
                    aria-label="Back to sidebar"
                    className="ghost-button ghost-button--back"
                    onClick={() => void onBack()}
                    title="Back"
                    type="button"
                  >
                    <SheetBackIcon />
                  </button>
                </div>
                <div className="chat-head__copy">
                  <div className="chat-head__title">
                    <h2>
                      {headerStatusDotTone ? (
                        <span
                          className={[
                            "status-dot",
                            `status-dot--${headerStatusDotTone}`
                          ].join(" ")}
                        />
                      ) : null}
                      {detail.session.title}
                    </h2>
                    {pendingCodexRequestCount > 0 ? (
                      <span className="badge badge--pending">{pendingCodexRequestCount} pending</span>
                    ) : null}
                  </div>
                  <p className="subtle">
                    Updated {formatRelativeTime(detail.session.updatedAt)}
                    {!draftRepoPicker ? ` · ${repoName ?? "unknown workspace"}` : ""}
                  </p>
                </div>
              </div>
              <div className="sidebar-menu chat-head__menu">
                <button
                  ref={actionsMenu.refs.setReference}
                  {...actionsMenu.getReferenceProps({
                    className: "sidebar-menu__trigger chat-head__menu-trigger",
                    type: "button",
                    "aria-expanded": isActionsMenuOpen,
                    "aria-label": "Open thread actions"
                  })}
                >
                  <span className="sr-only">Open thread actions</span>
                  <MoreActionsIcon />
                </button>

                {isActionsMenuOpen ? (
                  <FloatingPortal>
                    <div
                      ref={actionsMenu.refs.setFloating}
                      className="sidebar-menu__popover chat-head__menu-popover"
                      style={actionsMenu.floatingStyles}
                      {...actionsMenu.getFloatingProps()}
                    >
                      <RunSettingsPanel
                        key={detail?.session.id ?? "idle"}
                        availableModels={availableModels}
                        isLoadingModels={isLoadingModels}
                        modelsError={modelsError}
                        runSettings={runSettings}
                        onRunSettingsChange={onRunSettingsChange}
                        onResetRunSettings={onResetRunSettings}
                      />

                      {canRename || canArchive || canRestore ? (
                        <section className="sidebar-menu__section">
                          <p className="sidebar-menu__section-title">Actions</p>
                          <div className="action-row">
                            {canRename ? (
                              <button
                                className="action-btn"
                                disabled={isRenaming || isArchiving || isRestoring}
                                onClick={() => {
                                  setIsActionsMenuOpen(false);
                                  void onRename();
                                }}
                                type="button"
                              >
                                <svg className="action-btn__icon" viewBox="0 0 16 16" fill="none">
                                  <path d="M11.5 2.5L13.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                  <path d="M4.5 9.5L11 3L13 5L6.5 11.5L3.5 12.5L4.5 9.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                                </svg>
                                {isRenaming ? "Renaming..." : "Rename"}
                              </button>
                            ) : null}

                            {canRestore ? (
                              <button
                                className="action-btn"
                                disabled={isRestoring || isRenaming || isArchiving}
                                onClick={() => {
                                  setIsActionsMenuOpen(false);
                                  void onRestore();
                                }}
                                type="button"
                              >
                                {isRestoring ? "Restoring..." : "Restore"}
                              </button>
                            ) : null}

                            {canArchive ? (
                              <button
                                className="action-btn action-btn--danger"
                                disabled={
                                  isArchiving || isRestoring || isRenaming ||
                                  isSubmitting || isInterrupting || sessionIsRunning
                                }
                                onClick={() => {
                                  setIsActionsMenuOpen(false);
                                  void onArchive();
                                }}
                                type="button"
                              >
                                <svg className="action-btn__icon" viewBox="0 0 16 16" fill="none">
                                  <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                                  <path d="M2 6.5H14" stroke="currentColor" strokeWidth="1.5" />
                                  <path d="M8 3V1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                </svg>
                                {isArchiving ? "Archiving..." : "Archive"}
                              </button>
                            ) : null}
                          </div>
                        </section>
                      ) : null}

                      {devSimulatorAvailable ? (
                        <section className="sidebar-menu__section">
                          <p className="sidebar-menu__section-title">Developer</p>
                          <div className="sidebar-menu__list">
                            {DEV_REQUEST_OPTIONS.map((option) => (
                              <button
                                key={option.value}
                                className="sidebar-menu__item"
                                disabled={isSimulatingCodexRequest}
                                onClick={() => {
                                  setIsActionsMenuOpen(false);
                                  void onSimulateCodexRequest(option.value);
                                }}
                                type="button"
                              >
                                <span>{option.label}</span>
                              </button>
                            ))}
                          </div>
                          {simulateCodexRequestError ? (
                            <p className="chat-head__settings-error">{simulateCodexRequestError}</p>
                          ) : null}
                        </section>
                      ) : null}

                      <section className="sidebar-menu__section">
                        <div className="debug-disclosure">
                          <button
                            className="debug-disclosure__trigger"
                            type="button"
                            aria-expanded={isDebugOpen}
                            onClick={() => setIsDebugOpen(!isDebugOpen)}
                          >
                            <svg className="debug-disclosure__chevron" viewBox="0 0 16 16" fill="none">
                              <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            Debug
                          </button>
                          {isDebugOpen ? (
                            <div className="debug-disclosure__body" style={{ display: "block" }}>
                              <div className="chat-head__debug-list">
                                <div className="chat-head__debug-row chat-head__debug-row--split">
                                  <div className="chat-head__debug-copy-block">
                                    <span className="chat-head__debug-label">Session ID</span>
                                    <MiddleTruncate as="code" className="chat-head__debug-value" suffixLength={10} text={detail.session.id} />
                                  </div>
                                  <button
                                    className={`chat-head__debug-copy-button ${copiedDebugField === "session-id" ? "is-copied" : ""}`}
                                    onClick={() => { void handleCopySessionId(); }}
                                    type="button"
                                    aria-label={copiedDebugField === "session-id" ? "Session ID copied" : "Copy Session ID"}
                                    title={copiedDebugField === "session-id" ? "Copied" : "Copy Session ID"}
                                  >
                                    <CopyIcon />
                                  </button>
                                </div>
                                <div className="chat-head__debug-row">
                                  <span className="chat-head__debug-label">latestTurn.status</span>
                                  <code className="chat-head__debug-value">{formatLatestTurnStatusDebug(detail)}</code>
                                </div>
                                <div className="chat-head__debug-row">
                                  <span className="chat-head__debug-label">thread.status.type</span>
                                  <code className="chat-head__debug-value">{formatThreadStatusTypeDebug(detail)}</code>
                                </div>
                                <div className="chat-head__debug-row">
                                  <span className="chat-head__debug-label">session.status.reason</span>
                                  <code className="chat-head__debug-value">{formatStatusReasonDebug(detail)}</code>
                                </div>
                                <div className="chat-head__debug-row">
                                  <span className="chat-head__debug-label">session.status.confidence</span>
                                  <code className="chat-head__debug-value">{formatStatusConfidenceDebug(detail)}</code>
                                </div>
                                {statusLooksSuspicious ? (
                                  <p className="chat-head__debug-note">
                                    This status is inferred from a thread snapshot and may be stale if another Codex client is active.
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </section>
                    </div>
                  </FloatingPortal>
                ) : null}
              </div>
            </div>
            {draftRepoPickerConfig ? (
              <div className="chat-topbar__draft-picker">
                <WorkspaceCombobox
                  className="chat-head__draft-repo-picker"
                  repos={orderedDraftRepos}
                  selectedRepoId={draftRepoPickerConfig.selectedRepoId}
                  formatRepoLabel={draftRepoPickerConfig.formatRepoLabel}
                  onSelectRepo={draftRepoPickerConfig.onSelectRepo}
                />
              </div>
            ) : null}

            {bannerRunState === "error" ? (
              <div className="run-banner run-banner--error">
                <div>
                  <strong>Run error</strong>
                  <p>
                    {detail.latestRun?.finishedAt
                      ? `Last run failed ${formatRelativeTime(detail.latestRun.finishedAt)}`
                      : "The latest run failed."}
                  </p>
                </div>
              </div>
            ) : bannerRunState === "interrupted" ? (
              <div className="run-banner run-banner--interrupted">
                <div>
                  <strong>Run interrupted</strong>
                  <p>
                    {detail.latestRun?.finishedAt
                      ? `Last run stopped ${formatRelativeTime(detail.latestRun.finishedAt)}`
                      : "The latest run was interrupted."}
                  </p>
                  {statusLooksSuspicious ? (
                    <p>
                      This interrupted status is heuristic and may be stale if another Codex client is still running.
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <ConversationTimeline
            messages={messages}
            messagesError={messagesError}
            isLoadingMessages={isLoadingMessages}
            streamingText={streamingText}
            liveActivities={liveActivities}
            timelineEndRef={timelineEndRef}
            optimisticMessage={effectiveOptimisticMessage}
            showPendingAssistant={showPendingAssistant}
            timelineRef={timelineRef}
            showJumpToLatest={showJumpToLatest}
            hasQueuedUpdates={hasQueuedUpdates}
            onJumpToLatest={() => scrollTimelineToBottom()}
            onOpenCommands={(commands) => setSheetState({ type: "command_list", commands })}
            onOpenFileChanges={(content) => setSheetState({ type: "file_list", content })}
            onOpenFileLink={(href) => openFilePreviewFromLink(href)}
            onOpenSearches={(searches) => setSheetState({ type: "search_list", searches })}
            onOpenImageViewer={(attachments, selectedIndex) => setImageViewerState({ attachments, selectedIndex })}
          />

          <div ref={composerShellRef} className="composer-shell">
            <div className="composer">
              <input
                ref={fileInputRef}
                className="composer-file-input"
                type="file"
                accept="image/*"
                multiple
                disabled={sessionIsArchived}
                onChange={handleImageSelect}
              />
              {selectedImages.length > 0 ? (
                <div className="composer-attachments">
                  {selectedImages.map((image) => (
                    <figure key={image.id} className="composer-attachment">
                      <button
                        className="composer-attachment__remove"
                        type="button"
                        onClick={() => removeSelectedImage(image.id)}
                        aria-label={`Remove ${image.file.name || "image"}`}
                      >
                        ×
                      </button>
                      <img src={image.previewUrl} alt="Selected image" />
                    </figure>
                  ))}
                </div>
              ) : null}
              {showComposerEmptyState ? (
                <div className="composer-empty-state" aria-live="polite">
                  <strong>No conversation yet</strong>
                  <p>Start with a prompt and keep the session around for later follow-up work.</p>
                </div>
              ) : null}
              <div className={`composer-input-row${threadDiffSourceList ? " composer-input-row--thread-diff-pill" : ""}`}>
                {threadDiffSourceList ? <ThreadDiffEntry count={threadDiffCount} onOpen={openThreadDiff} /> : null}
                <div className="composer-field">
                  <textarea
                    ref={composerRef}
                    placeholder={sessionIsArchived ? "Restore this thread to continue..." : ACTIVE_COMPOSER_PLACEHOLDER}
                    disabled={sessionIsArchived}
                    onKeyDown={handleComposerKeyDown}
                    onPaste={handleComposerPaste}
                    onInput={autoResize}
                    rows={1}
                  />
                  <div className="composer-actions">
                    <button
                      className="composer-attach"
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      aria-label="Attach images"
                      disabled={sessionIsArchived || isSubmitting || selectedImages.length >= MAX_IMAGE_ATTACHMENTS}
                    >
                      <span className="sr-only">Attach images</span>
                      <ImageIcon />
                    </button>
                    {hasPendingRun ? (
                      <button
                        className="composer-send composer-send--stop"
                        disabled={isInterrupting || !interruptButtonEnabled}
                        onClick={() => void onInterrupt()}
                        type="button"
                        aria-label={interruptButtonEnabled ? "Stop" : "Preparing run"}
                      >
                        {isInterrupting ? "..." : "■"}
                      </button>
                    ) : (
                      <button
                        className="composer-send"
                        disabled={sessionIsArchived || isSubmitting}
                        onClick={() => void handleSubmit()}
                        type="button"
                        aria-label="Send"
                      >
                        {isSubmitting ? "..." : "↑"}
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {selectedImages.length > 0 ? (
                <div className="composer-meta">
                  <span>{selectedImages.length} / {MAX_IMAGE_ATTACHMENTS} images attached</span>
                </div>
              ) : null}
              {submitError ? <p className="composer-error">{submitError}</p> : null}
            </div>
          </div>
        </>
      ) : viewState.kind === "loading" ? (
        <ChatSkeletonContent />
      ) : viewState.kind === "error" ? (
        <div className="empty-state empty-state--chat">
          <strong>Unable to load this thread</strong>
          <p>{viewState.message}</p>
        </div>
      ) : (
        <div className="empty-state empty-state--chat">
          <strong>Select a thread</strong>
          <p>Choose a session from the sidebar or create a new one to start a run.</p>
        </div>
      )}

      {sheetState?.type === "command_list" ? (
        <CommandListSheet
          commands={sheetState.commands}
          onClose={() => setSheetState(null)}
          onSelect={(selectedIndex) =>
            setSheetState({
              type: "command_detail",
              commands: sheetState.commands,
              selectedIndex
            })
          }
        />
      ) : null}

      {sheetState?.type === "command_detail" ? (
        <CommandDetailSheet
          commands={sheetState.commands}
          selectedIndex={sheetState.selectedIndex}
          onClose={() => setSheetState(null)}
          onBack={() => setSheetState({ type: "command_list", commands: sheetState.commands })}
        />
      ) : null}

      {sheetState?.type === "file_list" ? (
        <FileChangeSheet
          content={sheetState.content}
          title={sheetState.content.title}
          onClose={() => setSheetState(null)}
          onSelect={(change, index) => openFilePreviewFromChange(change, sheetState.content, index)}
        />
      ) : null}

      {sheetState?.type === "file_preview" && detail ? (
        <FilePreviewSheet
          sessionId={detail.session.id}
          request={sheetState.request}
          sourceList={sheetState.sourceList}
          selectedIndex={sheetState.selectedIndex}
          isMobileViewport={isMobileViewport}
          onClose={() => setSheetState(null)}
          onBack={
            sheetState.sourceList
              ? () =>
                  setSheetState({
                    type: "file_list",
                    content: sheetState.sourceList!
                  })
              : undefined
          }
          onNavigateFile={navigateFilePreview}
          onOpenFileLink={(href) => openFilePreviewFromLink(href, sheetState.sourceList)}
        />
      ) : null}

      {sheetState?.type === "search_list" ? (
        <SearchListSheet searches={sheetState.searches} onClose={() => setSheetState(null)} />
      ) : null}

      {imageViewerState ? (
        <ImageViewer
          attachments={imageViewerState.attachments}
          selectedIndex={imageViewerState.selectedIndex}
          onSelect={(selectedIndex) =>
            setImageViewerState((current) => (current ? { ...current, selectedIndex } : current))
          }
          onClose={() => setImageViewerState(null)}
        />
      ) : null}
    </div>
  );
}
