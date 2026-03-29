import { memo, useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, RefObject } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type {
  LiveActivity,
  Message,
  MessageAttachment,
  SessionDetail
} from "../../../../../packages/shared-types/src/index";
import { formatClock, formatRelativeTime } from "../../components/formatters";

type OptimisticUserMessage = {
  prompt: string;
  attachments: MessageAttachment[];
};

type ComposerImage = {
  id: string;
  file: File;
  previewUrl: string;
};

type Props = {
  detail: SessionDetail | null | undefined;
  isLoadingDetail: boolean;
  messages: Message[];
  streamingText: string;
  liveActivities: LiveActivity[];
  optimisticMessage?: OptimisticUserMessage | null;
  wsState: string;
  backendMode: "real" | "mock" | undefined;
  repoName?: string;
  onBack: () => void;
  onToggleSidebar: () => void;
  onSubmit: (payload: { prompt: string; files: File[] }) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onRename: () => Promise<void>;
  isSubmitting: boolean;
  isInterrupting: boolean;
  isRenaming: boolean;
  canRename: boolean;
};

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
      return { rowRole: "user", label: "user", tone: "user" };
    case "assistant_thinking":
      return { rowRole: "assistant", label: null, tone: "thinking" };
    case "plan":
      return { rowRole: "assistant", label: "plan", tone: "thinking" };
    case "reasoning":
      return { rowRole: "assistant", label: "reasoning", tone: "thinking" };
    case "command_execution":
      return { rowRole: "system", label: "terminal", tone: "command" };
    case "file_change":
      return { rowRole: "system", label: "files", tone: "artifact" };
    case "mcp_tool_call":
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return { rowRole: "system", label: "tool", tone: "tool" };
    case "web_search":
      return { rowRole: "system", label: "search", tone: "search" };
    case "image_view":
    case "image_generation":
      return { rowRole: "system", label: "image", tone: "artifact" };
    case "review_mode_entered":
    case "review_mode_exited":
      return { rowRole: "system", label: "review", tone: "review" };
    case "context_compaction":
      return { rowRole: "system", label: "system", tone: "note" };
    case "run_error":
      return { rowRole: "system", label: "error", tone: "error" };
    case "assistant_message":
    default:
      return { rowRole: "assistant", label: "assistant", tone: "assistant" };
  }
}

function shouldShowMessageStatus(message: Message) {
  return (
    message.kind === "command_execution" ||
    message.kind === "file_change" ||
    message.kind === "mcp_tool_call" ||
    message.kind === "dynamic_tool_call" ||
    message.kind === "collab_agent_tool_call" ||
    message.kind === "image_generation" ||
    message.kind === "run_error"
  );
}

const MessageBody = memo(function MessageBody({ text }: { text: string }) {
  return (
    <div className="message-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
});

function CollapsibleBody({ text, label }: { text: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="collapsible-body" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="collapsible-body__toggle">
        {open ? "Hide" : "Show"} {label} output
      </summary>
      <MessageBody text={text} />
    </details>
  );
}

const MessageAttachments = memo(function MessageAttachments({
  attachments
}: {
  attachments: MessageAttachment[];
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="message-attachments">
      {attachments.map((attachment, index) => (
        <a
          key={`${attachment.url}:${index}`}
          className="message-attachment"
          href={attachment.url}
          target="_blank"
          rel="noreferrer"
        >
          <img src={attachment.url} alt={attachment.name} loading="lazy" />
          <span>{attachment.name}</span>
        </a>
      ))}
    </div>
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

const ConversationTimeline = memo(function ConversationTimeline({
  messages,
  streamingText,
  liveActivities,
  optimisticMessage,
  showPendingAssistant,
  timelineRef
}: {
  messages: Message[];
  streamingText: string;
  liveActivities: LiveActivity[];
  optimisticMessage?: OptimisticUserMessage | null;
  showPendingAssistant: boolean;
  timelineRef: RefObject<HTMLDivElement | null>;
}) {
  const hasConfirmedOptimistic =
    Boolean(optimisticMessage) &&
    messages.some((message) => optimisticMessage ? messageMatchesOptimistic(message, optimisticMessage) : false);

  return (
    <div ref={timelineRef} className="timeline-wrap">
      <div className="timeline">
        <ActivityTray activities={liveActivities} />
        {messages.map((message) => {
          const presentation = messagePresentation(message);
          const showLabel = Boolean(presentation.label);
          const showStatus = Boolean(message.status && shouldShowMessageStatus(message));

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
              <header className={`message-meta ${!showLabel && !showStatus ? "message-meta--time-only" : ""}`}>
                {showLabel || showStatus ? (
                  <div className="message-meta__title">
                    {showLabel ? <strong>{presentation.label}</strong> : null}
                    {showStatus ? (
                    <span className="message-status">{message.status}</span>
                    ) : null}
                  </div>
                ) : (
                  <span />
                )}
                <time>{formatClock(message.createdAt)}</time>
              </header>
              {message.attachments?.length ? <MessageAttachments attachments={message.attachments} /> : null}
              {message.text ? (
                message.kind === "command_execution" ? (
                  <CollapsibleBody text={message.text} label="terminal" />
                ) : (
                  <MessageBody text={message.text} />
                )
              ) : null}
            </div>
          </article>
          );
        })}

        {optimisticMessage && !hasConfirmedOptimistic ? (
          <article className="message-row message-row--user">
            <div className="message-card message-card--user">
              <header className="message-meta">
                <strong>user</strong>
                <span>just now</span>
              </header>
              {optimisticMessage.attachments.length ? (
                <MessageAttachments attachments={optimisticMessage.attachments} />
              ) : null}
              {optimisticMessage.prompt ? <MessageBody text={optimisticMessage.prompt} /> : null}
            </div>
          </article>
        ) : null}

        {streamingText ? (
          <article className="message-row message-row--assistant">
            <div className="message-card message-card--assistant message-card--thinking message-card--streaming">
              <header className="message-meta">
                <div className="message-meta__title">
                  <strong>thinking</strong>
                  <span className="message-status">streaming</span>
                </div>
                <span>live</span>
              </header>
              <MessageBody text={streamingText} />
            </div>
          </article>
        ) : null}

        {!streamingText && showPendingAssistant ? (
          <article className="message-row message-row--assistant">
            <div className="message-card message-card--assistant message-card--thinking message-card--pending">
              <header className="message-meta">
                <div className="message-meta__title">
                  <strong>thinking</strong>
                  <span className="message-status">pending</span>
                </div>
                <span>now</span>
              </header>
              <p className="thinking-text">Thinking...</p>
            </div>
          </article>
        ) : null}

        {messages.length === 0 && !streamingText && !optimisticMessage && !showPendingAssistant ? (
          <div className="empty-state empty-state--chat">
            <strong>No conversation yet</strong>
            <p>Start with a prompt and keep the session around for later follow-up work.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
});

function ChatSkeletonContent() {
  return (
    <>
      <div className="chat-head">
        <div>
          <div className="skeleton skeleton--title" />
          <div className="skeleton skeleton--subtitle" />
        </div>
      </div>
      <div className="timeline-wrap">
        <div className="timeline">
          <div className="skeleton skeleton--message skeleton--message-wide" />
          <div className="skeleton skeleton--message" />
          <div className="skeleton skeleton--message skeleton--message-wide" />
        </div>
      </div>
    </>
  );
}

export function ChatPane({
  detail,
  isLoadingDetail,
  messages,
  streamingText,
  liveActivities,
  optimisticMessage,
  wsState,
  backendMode,
  repoName,
  onBack,
  onToggleSidebar,
  onSubmit,
  onInterrupt,
  onRename,
  isSubmitting,
  isInterrupting,
  isRenaming,
  canRename
}: Props) {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectedImagesRef = useRef<ComposerImage[]>([]);
  const [selectedImages, setSelectedImages] = useState<ComposerImage[]>([]);
  const openedSessionRef = useRef<{ id: string | null; openedAt: number }>({
    id: null,
    openedAt: 0
  });

  const activeRunState = detail?.activeRun?.status ?? null;
  const latestRunState = detail?.latestRun?.status ?? null;
  const sessionIsRunning = activeRunState === "running" || detail?.session.status === "running";
  const bannerRunState = activeRunState ?? (sessionIsRunning ? "running" : null) ?? (latestRunState === "error" ? "error" : null);
  const showPendingAssistant =
    !streamingText && (Boolean(optimisticMessage) || sessionIsRunning || isSubmitting);

  useEffect(() => {
    selectedImagesRef.current = selectedImages;
  }, [selectedImages]);

  useEffect(() => () => revokeComposerImages(selectedImagesRef.current), []);

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

    openedSessionRef.current = {
      id: detail.session.id,
      openedAt: Date.now()
    };
  }, [detail?.session.id]);

  useEffect(() => {
    const timeline = timelineRef.current;
    const sessionId = detail?.session.id;
    if (!timeline || !sessionId) {
      return;
    }

    const isCurrentSession = openedSessionRef.current.id === sessionId;
    const justOpened = isCurrentSession && Date.now() - openedSessionRef.current.openedAt < 5000;
    const isNewSession = !isCurrentSession;

    if (!justOpened && !isNewSession) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      if (timelineRef.current) {
        timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [detail?.session.id, messages.length, streamingText]);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }

    const distanceFromBottom = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop;
    if (distanceFromBottom > 120) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      if (timelineRef.current) {
        timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [messages, streamingText]);

  const handleSubmit = () => {
    const prompt = composerRef.current?.value.trim() ?? "";
    if (!prompt && selectedImages.length === 0) {
      return;
    }

    const files = selectedImages.map((image) => image.file);

    // Clear composer immediately for snappy feedback — the optimistic message
    // already reflects the user's input in the timeline.
    if (composerRef.current) {
      composerRef.current.value = "";
      composerRef.current.style.height = "auto";
    }
    clearSelectedImages();

    void onSubmit({ prompt, files });
  };

  const autoResize = () => {
    const textarea = composerRef.current;
    if (!textarea) {
      return;
    }
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

    const nextImages = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file)
    }));

    setSelectedImages((current) => [...current, ...nextImages]);
    event.target.value = "";
  };

  const removeSelectedImage = (imageId: string) => {
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
    <div className="chat-card">
      <div className="chat-toolbar">
        <div className="chat-toolbar__left">
          <button className="ghost-button ghost-button--back" onClick={() => void onBack()} type="button">
            <span aria-hidden="true">←</span> Back
          </button>
          <button
            className="ghost-button ghost-button--toggle"
            onClick={onToggleSidebar}
            type="button"
            aria-label="Toggle sidebar"
          >
            ☰
          </button>
        </div>
        {detail ? (
          <div className="chat-toolbar__meta">
            <span
              className={[
                "status-badge",
                `status-badge--${bannerRunState ?? detail.session.status ?? "idle"}`
              ].join(" ")}
            >
              {detail.session.status ?? "idle"}
            </span>
          </div>
        ) : null}
      </div>

      {detail ? (
        <>
          <div className="chat-head">
            <div>
              <h2>
                <span
                  className={[
                    "status-dot",
                    `status-dot--${bannerRunState ?? detail.session.status ?? "idle"}`
                  ].join(" ")}
                />
                {detail.session.title}
              </h2>
              <p className="subtle">
                Updated {formatRelativeTime(detail.session.updatedAt)} · {repoName ?? "unknown workspace"}
              </p>
            </div>
            {canRename ? (
              <button className="ghost-button ghost-button--compact" onClick={() => void onRename()} type="button">
                {isRenaming ? "Renaming..." : "Rename"}
              </button>
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

          <ConversationTimeline
            messages={messages}
            streamingText={streamingText}
            liveActivities={liveActivities}
            optimisticMessage={optimisticMessage}
            showPendingAssistant={showPendingAssistant}
            timelineRef={timelineRef}
          />

          <div className="composer-shell">
            <div className="composer">
              <input
                ref={fileInputRef}
                className="composer-file-input"
                type="file"
                accept="image/*"
                multiple
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
                      <img src={image.previewUrl} alt={image.file.name || "Selected image"} />
                      <figcaption>{image.file.name || "image"}</figcaption>
                    </figure>
                  ))}
                </div>
              ) : null}
              <div className="composer-input-row">
                <button
                  className="composer-attach"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Attach images"
                >
                  Image
                </button>
                <textarea
                  ref={composerRef}
                  placeholder="Describe a task or ask a question..."
                  onKeyDown={handleComposerKeyDown}
                  onInput={autoResize}
                  rows={1}
                />
                {sessionIsRunning ? (
                  <button
                    className="composer-send composer-send--stop"
                    disabled={isInterrupting}
                    onClick={() => void onInterrupt()}
                    type="button"
                    aria-label="Stop"
                  >
                    {isInterrupting ? "..." : "■"}
                  </button>
                ) : (
                  <button
                    className="composer-send"
                    disabled={isSubmitting}
                    onClick={() => void handleSubmit()}
                    type="button"
                    aria-label="Send"
                  >
                    {isSubmitting ? "..." : "↑"}
                  </button>
                )}
              </div>
              <div className="composer-meta">
                <span>
                  {selectedImages.length > 0
                    ? `${selectedImages.length} image${selectedImages.length === 1 ? "" : "s"} attached`
                    : "Attach screenshots or diagrams when needed"}
                </span>
                <span>⌘/Ctrl+Enter to send · Shift+Enter for newline</span>
              </div>
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
    </div>
  );
}
