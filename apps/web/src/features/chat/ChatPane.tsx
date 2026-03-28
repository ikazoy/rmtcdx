import { useState } from "react";

import type { Message, SessionDetail } from "../../../../../packages/shared-types/src/index";
import { formatClock, formatRelativeTime } from "../../components/formatters";
import { StatusPill } from "../../components/StatusPill";

type Props = {
  detail: SessionDetail | null | undefined;
  messages: Message[];
  streamingText: string;
  wsState: string;
  backendMode: "real" | "mock" | undefined;
  onSubmit: (prompt: string) => Promise<void>;
  onInterrupt: () => Promise<void>;
  isSubmitting: boolean;
  isInterrupting: boolean;
};

export function ChatPane({
  detail,
  messages,
  streamingText,
  wsState,
  backendMode,
  onSubmit,
  onInterrupt,
  isSubmitting,
  isInterrupting
}: Props) {
  const [draft, setDraft] = useState("");

  const runState = detail?.activeRun?.status ?? detail?.latestRun?.status;

  const handleSubmit = async () => {
    const prompt = draft.trim();
    if (!prompt) {
      return;
    }
    setDraft("");
    await onSubmit(prompt);
  };

  return (
    <div className="pane-card pane-card--chat">
      {detail ? (
        <>
          <div className="pane-head pane-head--chat">
            <div>
              <p className="eyebrow">Chat</p>
              <h2>{detail.session.title}</h2>
              <p className="subtle">
                Updated {formatRelativeTime(detail.session.updatedAt)} · {backendMode ?? "unknown"} backend
              </p>
            </div>
            <div className="status-row">
              <StatusPill
                label={detail.session.status}
                tone={
                  detail.session.status === "error"
                    ? "danger"
                    : detail.session.status === "completed"
                      ? "success"
                      : detail.session.status === "running"
                        ? "accent"
                        : "neutral"
                }
              />
              <StatusPill label={wsState} tone={wsState === "connected" ? "success" : "neutral"} />
            </div>
          </div>

          {runState ? (
            <div className={`run-banner run-banner--${runState}`}>
              <div>
                <strong>{runState === "running" ? "Run in progress" : `Run ${runState}`}</strong>
                <p>
                  {detail.latestRun?.finishedAt
                    ? `Last run finished ${formatRelativeTime(detail.latestRun.finishedAt)}`
                    : "Waiting for the next prompt"}
                </p>
              </div>
              {detail.activeRun ? (
                <button className="ghost-button" onClick={() => void onInterrupt()} type="button">
                  {isInterrupting ? "Stopping..." : "Interrupt"}
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="timeline">
            {messages.map((message) => (
              <article key={message.id} className={`bubble bubble--${message.role}`}>
                <header>
                  <strong>{message.role}</strong>
                  <time>{formatClock(message.createdAt)}</time>
                </header>
                <pre>{message.text}</pre>
              </article>
            ))}
            {streamingText ? (
              <article className="bubble bubble--assistant is-streaming">
                <header>
                  <strong>assistant</strong>
                  <span>streaming</span>
                </header>
                <pre>{streamingText}</pre>
              </article>
            ) : null}
            {messages.length === 0 && !streamingText ? (
              <div className="empty-state empty-state--chat">
                <strong>No conversation yet</strong>
                <p>Start with a prompt and keep the session around for later follow-up work.</p>
              </div>
            ) : null}
          </div>

          <div className="composer">
            <textarea
              placeholder="Investigate the current issue, apply the fix, and verify locally."
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={4}
            />
            <button className="action-button action-button--large" disabled={isSubmitting} onClick={() => void handleSubmit()} type="button">
              {isSubmitting ? "Sending..." : "Send prompt"}
            </button>
          </div>
        </>
      ) : (
        <div className="empty-state empty-state--chat">
          <strong>Select a session</strong>
          <p>Choose an existing session or create a new one to start a run.</p>
        </div>
      )}
    </div>
  );
}
