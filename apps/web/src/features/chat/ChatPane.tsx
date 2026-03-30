import { memo, useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  ChangeEvent,
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject
} from "react";
import ReactMarkdown from "react-markdown";
import remend from "remend";
import remarkGfm from "remark-gfm";

import type {
  FileChangeEntry,
  LiveActivity,
  Message,
  MessageAttachment,
  SessionDetail
} from "../../../../../packages/shared-types/src/index";
import { formatRelativeTime } from "../../components/formatters";
import { sessionDisplayStatus } from "../sessions/session-state";

const MAX_IMAGE_ATTACHMENTS = 5;
const TIMELINE_PIN_THRESHOLD_MIN_PX = 120;
const TIMELINE_PIN_THRESHOLD_MAX_PX = 220;
const TIMELINE_PIN_THRESHOLD_VIEWPORT_RATIO = 0.18;

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
  | { type: "file_group"; id: string; changes: FileChangeEntry[]; count: number; createdAt: string }
  | { type: "search_group"; id: string; searches: SearchQueryEntry[]; createdAt: string };

type BottomSheetState =
  | null
  | { type: "command_list"; commands: CommandExecutionEntry[] }
  | { type: "command_detail"; commands: CommandExecutionEntry[]; selectedIndex: number }
  | { type: "file_list"; changes: FileChangeEntry[]; count: number }
  | { type: "search_list"; searches: SearchQueryEntry[] };

type ImageViewerState =
  | null
  | {
      attachments: MessageAttachment[];
      selectedIndex: number;
    };

type Props = {
  detail: SessionDetail | null | undefined;
  isLoadingDetail: boolean;
  isLoadingMessages: boolean;
  messages: Message[];
  streamingText: string;
  liveActivities: LiveActivity[];
  isMobileViewport: boolean;
  optimisticMessage?: OptimisticUserMessage | null;
  wsState: string;
  backendMode: "real" | "mock" | undefined;
  repoName?: string;
  onBack: () => void;
  onSubmit: (payload: { prompt: string; files: File[] }) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onRename: () => Promise<void>;
  onArchive: () => Promise<void>;
  onRestore: () => Promise<void>;
  isSubmitting: boolean;
  isInterrupting: boolean;
  isRenaming: boolean;
  isArchiving: boolean;
  isRestoring: boolean;
  canRename: boolean;
  canArchive: boolean;
  canRestore: boolean;
};

function timelineIsPinnedToBottom(timeline: HTMLDivElement) {
  return timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop <= timelinePinThresholdPx();
}

function readRootScrollTop() {
  if (typeof document === "undefined") {
    return 0;
  }

  return document.scrollingElement?.scrollTop ?? window.scrollY ?? 0;
}

function timelineViewportIsPinnedToBottom(timelineEnd: HTMLElement, composerHeight: number) {
  return timelineEnd.getBoundingClientRect().bottom <= window.innerHeight - composerHeight + timelinePinThresholdPx();
}

function revokeComposerImages(images: ComposerImage[]) {
  for (const image of images) {
    URL.revokeObjectURL(image.previewUrl);
  }
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

function fileChangesFromMessage(message: Message) {
  return message.metadata?.type === "file_change" ? message.metadata.changes : [];
}

function fileChangeCountFromMessage(message: Message) {
  if (message.metadata?.type === "file_change") {
    return message.metadata.changes.length;
  }

  const match = /Updated\s+(\d+)\s+file/.exec(message.text);
  return match ? Number(match[1]) : 0;
}

function searchQueryFromMessage(message: Message) {
  if (message.metadata?.type === "web_search") {
    return message.metadata.query.trim();
  }

  return message.text.replace(/^Query:\s*/i, "").trim() || message.text.trim();
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

      const changes = fileMessages.flatMap((item) => fileChangesFromMessage(item));
      const count = fileMessages.reduce((sum, item) => sum + fileChangeCountFromMessage(item), 0);

      entries.push({
        type: "file_group",
        id: `file-group:${fileMessages[0]!.id}`,
        changes,
        count: Math.max(count, changes.length),
        createdAt: fileMessages[fileMessages.length - 1]!.createdAt
      });
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

const MessageBody = memo(function MessageBody({
  text,
  repairIncompleteMarkdown = false
}: {
  text: string;
  repairIncompleteMarkdown?: boolean;
}) {
  const markdown = repairIncompleteMarkdown ? remend(text, { linkMode: "text-only" }) : text;

  return (
    <div className="message-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
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

function MoreActionsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="12" r="1.8" fill="currentColor" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      <circle cx="18" cy="12" r="1.8" fill="currentColor" />
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
                  <span className="summary-card__row-text">{row.text}</span>
                </span>
                {row.detail ? <span className="summary-card__row-detail">{row.detail}</span> : null}
              </div>
            </div>
          ))}
        </div>
        {extraCount > 0 ? <div className="summary-card__more">+{extraCount}</div> : null}
      </button>
    </article>
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
  children
}: {
  title: string;
  subtitle?: string | null;
  onClose: () => void;
  onBack?: () => void;
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
                <button className="bottom-sheet__icon-button" type="button" aria-label="Back" onClick={onBack}>
                  <SheetBackIcon />
                </button>
              ) : null}
            </div>
            <div className="bottom-sheet__headline">
              <strong>{title}</strong>
              {subtitle ? <span>{subtitle}</span> : null}
            </div>
            <div className="bottom-sheet__side bottom-sheet__side--end">
              <button className="bottom-sheet__icon-button" type="button" aria-label="Close" onClick={onClose}>
                <SheetCloseIcon />
              </button>
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
  changes,
  count,
  onClose
}: {
  changes: FileChangeEntry[];
  count: number;
  onClose: () => void;
}) {
  return (
    <BottomSheet title={formatFileGroupTitle(count)} onClose={onClose}>
      <div className="sheet-list">
        {changes.length > 0 ? (
          changes.map((change, index) => (
            <div key={`${change.path}:${index}`} className="sheet-row">
              <span className="sheet-row__icon sheet-row__icon--file">
                <FileIcon />
              </span>
              <div className="sheet-row__copy">
                <span className="sheet-row__title">
                  <span className="sheet-row__eyebrow sheet-row__eyebrow--inline">{fileChangeVerb(change)}</span>
                  {change.movePath ?? change.path}
                </span>
                {change.movePath ? <span className="sheet-row__meta">{change.path}</span> : null}
              </div>
            </div>
          ))
        ) : (
          <p className="sheet-empty">No file details were recorded for this run.</p>
        )}
      </div>
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
  onOpenSearches,
  onOpenImageViewer
}: {
  messages: Message[];
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
  onOpenFileChanges: (changes: FileChangeEntry[], count: number) => void;
  onOpenSearches: (searches: SearchQueryEntry[]) => void;
  onOpenImageViewer: (attachments: MessageAttachment[], selectedIndex: number) => void;
}) {
  const entries = buildTimelineEntries(messages);
  const hasConfirmedOptimistic =
    Boolean(optimisticMessage) &&
    messages.some((message) => optimisticMessage ? messageMatchesOptimistic(message, optimisticMessage) : false);
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
              const previewRows = entry.changes.slice(0, 5).map((change, index) => ({
                id: `${change.path}:${index}`,
                prefix: fileChangeVerb(change),
                text: change.movePath ?? change.path,
                detail: change.movePath ? change.path : null
              }));

              return (
                <SummaryCard
                  key={entry.id}
                  tone="file"
                  title={formatFileGroupTitle(entry.count)}
                  rows={previewRows}
                  extraCount={Math.max(0, entry.count - previewRows.length)}
                  onClick={() => onOpenFileChanges(entry.changes, entry.count)}
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
                  {message.text ? <MessageBody text={message.text} repairIncompleteMarkdown={message.role !== "user"} /> : null}
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
                {optimisticMessage.prompt ? <MessageBody text={optimisticMessage.prompt} /> : null}
              </div>
            </article>
          ) : null}

          {streamingText ? (
            <article className="message-row message-row--assistant">
              <div className="message-card message-card--assistant message-card--thinking message-card--streaming">
                <MessageBody text={streamingText} repairIncompleteMarkdown />
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
  detail,
  isLoadingDetail,
  isLoadingMessages,
  messages,
  streamingText,
  liveActivities,
  isMobileViewport,
  optimisticMessage,
  wsState,
  backendMode,
  repoName,
  onBack,
  onSubmit,
  onInterrupt,
  onRename,
  onArchive,
  onRestore,
  isSubmitting,
  isInterrupting,
  isRenaming,
  isArchiving,
  isRestoring,
  canRename,
  canArchive,
  canRestore
}: Props) {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  const selectedImagesRef = useRef<ComposerImage[]>([]);
  const autoFollowEnabledRef = useRef(true);
  const isPinnedToBottomRef = useRef(true);
  const isProgrammaticScrollRef = useRef(false);
  const lastTimelineScrollTopRef = useRef(0);
  const shouldScrollToBottomRef = useRef(true);
  const touchStartYRef = useRef<number | null>(null);
  const [selectedImages, setSelectedImages] = useState<ComposerImage[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sheetState, setSheetState] = useState<BottomSheetState>(null);
  const [imageViewerState, setImageViewerState] = useState<ImageViewerState>(null);
  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [hasQueuedUpdates, setHasQueuedUpdates] = useState(false);
  const [composerShellHeight, setComposerShellHeight] = useState(0);
  const [visualViewportBottomInset, setVisualViewportBottomInset] = useState(0);

  const activeRunState = detail?.activeRun?.status ?? null;
  const latestRunState = detail?.latestRun?.status ?? null;
  const sessionIsArchived = Boolean(detail?.session.isArchived);
  const sessionIsRunning = activeRunState === "running" || detail?.session.status === "running";
  const hasPendingRun = sessionIsRunning || isSubmitting || Boolean(optimisticMessage);
  const canInterruptRun = Boolean(detail?.activeRun?.id) && !isSubmitting;
  const bannerRunState = activeRunState ?? (sessionIsRunning ? "running" : null) ?? (latestRunState === "error" ? "error" : null);
  const sessionBadgeState = detail ? sessionDisplayStatus(detail.session) : "idle";
  const showPendingAssistant =
    !streamingText && (Boolean(optimisticMessage) || sessionIsRunning || isSubmitting);
  const showComposerEmptyState =
    !isLoadingMessages && messages.length === 0 && !streamingText && !optimisticMessage && !showPendingAssistant;
  const usesRootScroll = isMobileViewport;

  const readCurrentScrollTop = () => (usesRootScroll ? readRootScrollTop() : timelineRef.current?.scrollTop ?? 0);

  const disableAutoFollow = () => {
    autoFollowEnabledRef.current = false;
    shouldScrollToBottomRef.current = false;
  };

  const syncTimelinePinnedState = (scrollDelta = 0, isProgrammaticScroll = false) => {
    const pinnedToBottom = usesRootScroll
      ? (timelineEndRef.current ? timelineViewportIsPinnedToBottom(timelineEndRef.current, composerShellHeight) : true)
      : (timelineRef.current ? timelineIsPinnedToBottom(timelineRef.current) : true);

    if (!isProgrammaticScroll && scrollDelta < -1) {
      disableAutoFollow();
    }

    if (pinnedToBottom && (isProgrammaticScroll || scrollDelta > 1)) {
      autoFollowEnabledRef.current = true;
    }

    isPinnedToBottomRef.current = pinnedToBottom;
    setShowJumpToLatest(!pinnedToBottom);

    if (pinnedToBottom) {
      setHasQueuedUpdates(false);
    }
  };

  const scrollTimelineToBottom = (behavior: ScrollBehavior = "auto") => {
    const timelineEnd = timelineEndRef.current;
    if (!timelineEnd) {
      return;
    }

    autoFollowEnabledRef.current = true;
    shouldScrollToBottomRef.current = false;
    isProgrammaticScrollRef.current = true;
    timelineEnd.scrollIntoView({ block: "end", behavior });
    lastTimelineScrollTopRef.current = readCurrentScrollTop();
    isPinnedToBottomRef.current = true;
    setShowJumpToLatest(false);
    setHasQueuedUpdates(false);

    window.requestAnimationFrame(() => {
      isProgrammaticScrollRef.current = false;
      lastTimelineScrollTopRef.current = readCurrentScrollTop();
      syncTimelinePinnedState(0, true);
    });
  };

  useEffect(() => {
    selectedImagesRef.current = selectedImages;
  }, [selectedImages]);

  useEffect(() => () => revokeComposerImages(selectedImagesRef.current), []);

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
    if (!isActionsMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!actionsMenuRef.current?.contains(event.target as Node)) {
        setIsActionsMenuOpen(false);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsActionsMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isActionsMenuOpen]);

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
        return;
      }

      if (event.key === "ArrowLeft") {
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

      if (event.key === "ArrowRight") {
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
  }, [imageViewerState, sheetState]);

  const clearSelectedImages = () => {
    setSelectedImages((current) => {
      revokeComposerImages(current);
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
    setSubmitError(null);
    setSheetState(null);
    setImageViewerState(null);
    setIsActionsMenuOpen(false);
    autoFollowEnabledRef.current = true;
    isPinnedToBottomRef.current = true;
    isProgrammaticScrollRef.current = false;
    lastTimelineScrollTopRef.current = 0;
    shouldScrollToBottomRef.current = true;
    touchStartYRef.current = null;
    setShowJumpToLatest(false);
    setHasQueuedUpdates(false);
  }, [detail?.session.id]);

  useEffect(() => {
    if (!showComposerEmptyState || sessionIsArchived) {
      return;
    }

    let scrollTimeout: number | null = null;
    const frame = window.requestAnimationFrame(() => {
      const composer = composerRef.current;
      if (!composer) {
        return;
      }

      if (usesRootScroll) {
        composer.focus();
        scrollTimeout = window.setTimeout(() => {
          composerShellRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
        }, 250);
        return;
      }

      composer.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(frame);
      if (scrollTimeout !== null) {
        window.clearTimeout(scrollTimeout);
      }
    };
  }, [detail?.session.id, sessionIsArchived, showComposerEmptyState, usesRootScroll]);

  useEffect(() => {
    const timeline = timelineRef.current;
    const scrollTarget = usesRootScroll ? window : timeline;
    const touchTarget = usesRootScroll ? document : timeline;
    if (!scrollTarget || !touchTarget) {
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
    scrollTarget.addEventListener("scroll", handleScroll, { passive: true });

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

    scrollTarget.addEventListener("wheel", handleWheel, { passive: true });
    touchTarget.addEventListener("touchstart", handleTouchStart, { passive: true });
    touchTarget.addEventListener("touchmove", handleTouchMove, { passive: true });
    touchTarget.addEventListener("touchend", resetTouchTracking, { passive: true });
    touchTarget.addEventListener("touchcancel", resetTouchTracking, { passive: true });

    return () => {
      scrollTarget.removeEventListener("scroll", handleScroll);
      scrollTarget.removeEventListener("wheel", handleWheel);
      touchTarget.removeEventListener("touchstart", handleTouchStart);
      touchTarget.removeEventListener("touchmove", handleTouchMove);
      touchTarget.removeEventListener("touchend", resetTouchTracking);
      touchTarget.removeEventListener("touchcancel", resetTouchTracking);
    };
  }, [composerShellHeight, detail?.session.id, usesRootScroll]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      lastTimelineScrollTopRef.current = readCurrentScrollTop();
      syncTimelinePinnedState(0, isProgrammaticScrollRef.current);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [composerShellHeight, detail?.session.id, usesRootScroll]);

  useEffect(() => {
    if (!timelineEndRef.current) {
      return;
    }

    if (!shouldScrollToBottomRef.current && !autoFollowEnabledRef.current) {
      setHasQueuedUpdates(true);
      return;
    }

    shouldScrollToBottomRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      scrollTimelineToBottom();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [liveActivities, messages, optimisticMessage, showPendingAssistant, streamingText]);

  const handleSubmit = async () => {
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
    const savedImages = [...selectedImages];

    isPinnedToBottomRef.current = true;
    shouldScrollToBottomRef.current = true;
    setShowJumpToLatest(false);
    setHasQueuedUpdates(false);

    if (composerRef.current) {
      composerRef.current.value = "";
      composerRef.current.style.height = "auto";
    }
    clearSelectedImages();

    try {
      await onSubmit({ prompt, files });
    } catch (error) {
      if (composerRef.current) {
        composerRef.current.value = prompt;
        composerRef.current.style.height = "auto";
      }
      setSelectedImages(savedImages);
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

  const handleImageSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) {
      event.target.value = "";
      return;
    }

    const remainingSlots = Math.max(0, MAX_IMAGE_ATTACHMENTS - selectedImagesRef.current.length);
    if (remainingSlots === 0) {
      setSubmitError(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images per message.`);
      event.target.value = "";
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

    const nextImages = acceptedFiles.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      previewUrl: URL.createObjectURL(file)
    }));

    setSelectedImages((current) => [...current, ...nextImages]);
    event.target.value = "";
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
                  <h2>
                    <span
                      className={["status-dot", `status-dot--${bannerRunState ?? sessionBadgeState}`].join(" ")}
                    />
                    {detail.session.title}
                  </h2>
                  <p className="subtle">
                    Updated {formatRelativeTime(detail.session.updatedAt)} · {repoName ?? "unknown workspace"}
                  </p>
                </div>
              </div>
              {canRename || canArchive || canRestore ? (
                <div ref={actionsMenuRef} className="sidebar-menu chat-head__menu">
                  <button
                    className="sidebar-menu__trigger chat-head__menu-trigger"
                    onClick={() => setIsActionsMenuOpen((current) => !current)}
                    type="button"
                    aria-expanded={isActionsMenuOpen}
                    aria-label="Open thread actions"
                  >
                    <span className="sr-only">Open thread actions</span>
                    <MoreActionsIcon />
                  </button>

                  {isActionsMenuOpen ? (
                    <div className="sidebar-menu__popover chat-head__menu-popover">
                      <section className="sidebar-menu__section">
                        <div className="sidebar-menu__list">
                          {canRename ? (
                            <button
                              className="sidebar-menu__item"
                              disabled={isRenaming || isArchiving || isRestoring}
                              onClick={() => {
                                setIsActionsMenuOpen(false);
                                void onRename();
                              }}
                              type="button"
                            >
                              <span>{isRenaming ? "Renaming..." : "Rename"}</span>
                            </button>
                          ) : null}

                          {canRestore ? (
                            <button
                              className="sidebar-menu__item"
                              disabled={isRestoring || isRenaming || isArchiving}
                              onClick={() => {
                                setIsActionsMenuOpen(false);
                                void onRestore();
                              }}
                              type="button"
                            >
                              <span>{isRestoring ? "Restoring..." : "Restore"}</span>
                            </button>
                          ) : null}

                          {canArchive ? (
                            <button
                              className="sidebar-menu__item sidebar-menu__item--danger"
                              disabled={
                                isArchiving ||
                                isRestoring ||
                                isRenaming ||
                                isSubmitting ||
                                isInterrupting ||
                                sessionIsRunning
                              }
                              onClick={() => {
                                setIsActionsMenuOpen(false);
                                void onArchive();
                              }}
                              type="button"
                            >
                              <span>{isArchiving ? "Archiving..." : "Archive"}</span>
                            </button>
                          ) : null}
                        </div>
                      </section>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

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
            ) : null}
          </div>

          <ConversationTimeline
            messages={messages}
            isLoadingMessages={isLoadingMessages}
            streamingText={streamingText}
            liveActivities={liveActivities}
            timelineEndRef={timelineEndRef}
            optimisticMessage={optimisticMessage}
            showPendingAssistant={showPendingAssistant}
            timelineRef={timelineRef}
            showJumpToLatest={showJumpToLatest}
            hasQueuedUpdates={hasQueuedUpdates}
            onJumpToLatest={() => scrollTimelineToBottom()}
            onOpenCommands={(commands) => setSheetState({ type: "command_list", commands })}
            onOpenFileChanges={(changes, count) => setSheetState({ type: "file_list", changes, count })}
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
              <div className="composer-input-row">
                <div className="composer-field">
                  <textarea
                    ref={composerRef}
                    placeholder={sessionIsArchived ? "Restore this thread to continue..." : "Describe a task or ask a question..."}
                    disabled={sessionIsArchived}
                    onKeyDown={handleComposerKeyDown}
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
                        disabled={isInterrupting || !canInterruptRun}
                        onClick={() => void onInterrupt()}
                        type="button"
                        aria-label={canInterruptRun ? "Stop" : "Preparing run"}
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
              {showComposerEmptyState ? (
                <div className="composer-empty-state" aria-live="polite">
                  <strong>No conversation yet</strong>
                  <p>Start with a prompt and keep the session around for later follow-up work.</p>
                </div>
              ) : null}
              {selectedImages.length > 0 ? (
                <div className="composer-meta">
                  <span>{selectedImages.length} / {MAX_IMAGE_ATTACHMENTS} images attached</span>
                </div>
              ) : null}
              {submitError ? <p className="composer-error">{submitError}</p> : null}
            </div>
          </div>
        </>
      ) : isLoadingDetail ? (
        <ChatSkeletonContent />
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
          changes={sheetState.changes}
          count={sheetState.count}
          onClose={() => setSheetState(null)}
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
