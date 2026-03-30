import { FloatingPortal } from "@floating-ui/react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type {
  CodexPendingRequest,
  CodexPendingRequestResponse,
  JsonValue
} from "@codex-remote/shared-types";

type Props = {
  request: CodexPendingRequest | null;
  isSubmitting: boolean;
  submitError: string | null;
  onRespond: (response: CodexPendingRequestResponse) => Promise<void>;
};

function permissionPaths(paths: string[] | null | undefined) {
  return paths?.filter(Boolean) ?? [];
}

function prettyJson(value: JsonValue | null) {
  return JSON.stringify(value ?? {}, null, 2);
}

function requestTitle(request: CodexPendingRequest) {
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
      return "MCP confirmation required";
  }
}

function requestSubtitle(request: CodexPendingRequest) {
  switch (request.type) {
    case "command_approval":
      return request.command ?? "Codex wants to run a command.";
    case "file_change_approval":
      return request.reason ?? "Codex wants to apply file changes.";
    case "permissions_approval":
      return request.reason ?? "Codex wants additional access.";
    case "request_user_input":
      return `${request.questions.length} question${request.questions.length === 1 ? "" : "s"}`;
    case "mcp_elicitation":
      return request.serverName;
  }
}

function RequestSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="codex-request-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function CodexRequestDialog({ request, isSubmitting, submitError, onRespond }: Props) {
  const [localError, setLocalError] = useState<string | null>(null);
  const [draftAnswers, setDraftAnswers] = useState<Record<string, string>>({});
  const [mcpContent, setMcpContent] = useState("{}");

  useEffect(() => {
    setLocalError(null);
    setDraftAnswers({});
    setMcpContent(request?.type === "mcp_elicitation" && request.mode === "form" ? "{}" : "{}");
  }, [request?.id, request?.type]);

  const requestSummary = useMemo(() => {
    if (!request) {
      return null;
    }

    if (request.type === "permissions_approval") {
      const readPaths = permissionPaths(request.permissions.fileSystem?.read);
      const writePaths = permissionPaths(request.permissions.fileSystem?.write);
      return {
        readPaths,
        writePaths,
        needsNetwork: request.permissions.network?.enabled === true
      };
    }

    if (request.type === "command_approval") {
      const readPaths = permissionPaths(request.requestedPermissions?.fileSystem?.read);
      const writePaths = permissionPaths(request.requestedPermissions?.fileSystem?.write);
      return {
        readPaths,
        writePaths,
        needsNetwork: request.requestedPermissions?.network?.enabled === true
      };
    }

    return null;
  }, [request]);

  if (!request) {
    return null;
  }

  const respond = async (response: CodexPendingRequestResponse) => {
    setLocalError(null);
    try {
      await onRespond(response);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Unable to respond to Codex request.");
    }
  };

  const submitRequestUserInput = async () => {
    if (request.type !== "request_user_input") {
      return;
    }

    const answers = Object.fromEntries(
      request.questions.flatMap((question) => {
        const answer = draftAnswers[question.id]?.trim();
        return answer ? [[question.id, { answers: [answer] }]] : [];
      })
    );

    if (Object.keys(answers).length !== request.questions.length) {
      setLocalError("Answer all questions before submitting.");
      return;
    }

    await respond({
      type: "request_user_input",
      answers
    });
  };

  const submitMcpAccept = async () => {
    if (request.type !== "mcp_elicitation") {
      return;
    }

    let content: JsonValue | null = null;
    if (request.mode === "form") {
      try {
        content = JSON.parse(mcpContent) as JsonValue;
      } catch {
        setLocalError("Form response must be valid JSON.");
        return;
      }
    }

    await respond({
      type: "mcp_elicitation",
      action: "accept",
      content,
      meta: request.meta
    });
  };

  return (
    <FloatingPortal>
      <div className="bottom-sheet-backdrop codex-request-backdrop" role="presentation">
        <div aria-modal="true" className="bottom-sheet codex-request-sheet" role="dialog">
          <header className="bottom-sheet__header codex-request-sheet__header">
            <div className="bottom-sheet__side" />
            <div className="bottom-sheet__headline">
              <strong>{requestTitle(request)}</strong>
              <span>{requestSubtitle(request)}</span>
            </div>
            <div className="bottom-sheet__side bottom-sheet__side--end">
              <span className="codex-request-badge">Pending</span>
            </div>
          </header>

          <div className="bottom-sheet__body codex-request-sheet__body">
            {request.type === "command_approval" ? (
              <>
                {request.reason ? (
                  <RequestSection title="Reason">
                    <p className="codex-request-copy">{request.reason}</p>
                  </RequestSection>
                ) : null}

                {request.command ? (
                  <RequestSection title="Command">
                    <pre className="codex-request-code">{request.command}</pre>
                    {request.cwd ? <p className="codex-request-meta">cwd: {request.cwd}</p> : null}
                  </RequestSection>
                ) : null}

                {request.commandActions?.length ? (
                  <RequestSection title="Parsed actions">
                    <div className="sheet-list">
                      {request.commandActions.map((action, index) => (
                        <div key={`${action.type}:${index}`} className="sheet-row">
                          <div className="sheet-row__copy">
                            <span className="sheet-row__eyebrow">{action.type}</span>
                            <span className="sheet-row__title">
                              {"path" in action && action.path ? action.path : action.command}
                            </span>
                            <span className="sheet-row__meta">{action.command}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </RequestSection>
                ) : null}

                {requestSummary ? (
                  <RequestSection title="Requested access">
                    <div className="sheet-meta">
                      {requestSummary.needsNetwork ? <span className="sheet-meta__badge">network</span> : null}
                      {requestSummary.readPaths.map((path) => (
                        <span key={`read:${path}`} className="sheet-meta__badge">
                          read {path}
                        </span>
                      ))}
                      {requestSummary.writePaths.map((path) => (
                        <span key={`write:${path}`} className="sheet-meta__badge">
                          write {path}
                        </span>
                      ))}
                    </div>
                  </RequestSection>
                ) : null}

                <div className="codex-request-actions">
                  {request.availableDecisions.includes("accept") ? (
                    <button
                      className="action-button"
                      disabled={isSubmitting}
                      type="button"
                      onClick={() => void respond({ type: "command_approval", decision: "accept" })}
                    >
                      Allow once
                    </button>
                  ) : null}
                  {request.availableDecisions.includes("acceptForSession") ? (
                    <button
                      className="ghost-button"
                      disabled={isSubmitting}
                      type="button"
                      onClick={() => void respond({ type: "command_approval", decision: "acceptForSession" })}
                    >
                      Allow for session
                    </button>
                  ) : null}
                  {request.availableDecisions.includes("decline") ? (
                    <button
                      className="ghost-button ghost-button--danger"
                      disabled={isSubmitting}
                      type="button"
                      onClick={() => void respond({ type: "command_approval", decision: "decline" })}
                    >
                      Decline
                    </button>
                  ) : null}
                  {request.availableDecisions.includes("cancel") ? (
                    <button
                      className="ghost-button"
                      disabled={isSubmitting}
                      type="button"
                      onClick={() => void respond({ type: "command_approval", decision: "cancel" })}
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}

            {request.type === "file_change_approval" ? (
              <>
                <RequestSection title="Reason">
                  <p className="codex-request-copy">{request.reason ?? "Codex wants to apply file changes."}</p>
                </RequestSection>

                {request.grantRoot ? (
                  <RequestSection title="Requested write root">
                    <pre className="codex-request-code">{request.grantRoot}</pre>
                  </RequestSection>
                ) : null}

                <div className="codex-request-actions">
                  <button
                    className="action-button"
                    disabled={isSubmitting}
                    type="button"
                    onClick={() => void respond({ type: "file_change_approval", decision: "accept" })}
                  >
                    Allow once
                  </button>
                  <button
                    className="ghost-button"
                    disabled={isSubmitting}
                    type="button"
                    onClick={() => void respond({ type: "file_change_approval", decision: "acceptForSession" })}
                  >
                    Allow for session
                  </button>
                  <button
                    className="ghost-button ghost-button--danger"
                    disabled={isSubmitting}
                    type="button"
                    onClick={() => void respond({ type: "file_change_approval", decision: "decline" })}
                  >
                    Decline
                  </button>
                  <button
                    className="ghost-button"
                    disabled={isSubmitting}
                    type="button"
                    onClick={() => void respond({ type: "file_change_approval", decision: "cancel" })}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : null}

            {request.type === "permissions_approval" ? (
              <>
                <RequestSection title="Reason">
                  <p className="codex-request-copy">{request.reason ?? "Codex wants additional access."}</p>
                </RequestSection>

                {requestSummary ? (
                  <RequestSection title="Requested access">
                    <div className="sheet-meta">
                      {requestSummary.needsNetwork ? <span className="sheet-meta__badge">network</span> : null}
                      {requestSummary.readPaths.map((path) => (
                        <span key={`read:${path}`} className="sheet-meta__badge">
                          read {path}
                        </span>
                      ))}
                      {requestSummary.writePaths.map((path) => (
                        <span key={`write:${path}`} className="sheet-meta__badge">
                          write {path}
                        </span>
                      ))}
                    </div>
                  </RequestSection>
                ) : null}

                <div className="codex-request-actions">
                  <button
                    className="action-button"
                    disabled={isSubmitting}
                    type="button"
                    onClick={() =>
                      void respond({
                        type: "permissions_approval",
                        permissions: {
                          network: request.permissions.network ?? undefined,
                          fileSystem: request.permissions.fileSystem ?? undefined
                        },
                        scope: "turn"
                      })
                    }
                  >
                    Allow for turn
                  </button>
                  <button
                    className="ghost-button"
                    disabled={isSubmitting}
                    type="button"
                    onClick={() =>
                      void respond({
                        type: "permissions_approval",
                        permissions: {
                          network: request.permissions.network ?? undefined,
                          fileSystem: request.permissions.fileSystem ?? undefined
                        },
                        scope: "session"
                      })
                    }
                  >
                    Allow for session
                  </button>
                  <button
                    className="ghost-button ghost-button--danger"
                    disabled={isSubmitting}
                    type="button"
                    onClick={() =>
                      void respond({
                        type: "permissions_approval",
                        permissions: {},
                        scope: "turn"
                      })
                    }
                  >
                    Deny
                  </button>
                </div>
              </>
            ) : null}

            {request.type === "request_user_input" ? (
              <>
                <div className="codex-request-question-list">
                  {request.questions.map((question) => (
                    <RequestSection key={question.id} title={question.header}>
                      <p className="codex-request-copy">{question.question}</p>
                      {question.options?.length ? (
                        <div className="codex-request-option-list">
                          {question.options.map((option) => {
                            const selected = draftAnswers[question.id] === option.label;
                            return (
                              <button
                                key={option.label}
                                className={`sheet-row sheet-row--button${selected ? " codex-request-option--selected" : ""}`}
                                disabled={isSubmitting}
                                type="button"
                                onClick={() =>
                                  setDraftAnswers((current) => ({
                                    ...current,
                                    [question.id]: option.label
                                  }))
                                }
                              >
                                <div className="sheet-row__copy">
                                  <span className="sheet-row__title">{option.label}</span>
                                  <span className="sheet-row__meta">{option.description}</span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                      <input
                        className="codex-request-input"
                        disabled={isSubmitting}
                        placeholder={question.isOther ? "Other answer" : "Answer"}
                        type={question.isSecret ? "password" : "text"}
                        value={draftAnswers[question.id] ?? ""}
                        onChange={(event) =>
                          setDraftAnswers((current) => ({
                            ...current,
                            [question.id]: event.target.value
                          }))
                        }
                      />
                    </RequestSection>
                  ))}
                </div>

                <div className="codex-request-actions">
                  <button className="action-button" disabled={isSubmitting} type="button" onClick={() => void submitRequestUserInput()}>
                    Submit answers
                  </button>
                </div>
              </>
            ) : null}

            {request.type === "mcp_elicitation" ? (
              <>
                <RequestSection title="Server">
                  <p className="codex-request-copy">{request.serverName}</p>
                </RequestSection>

                <RequestSection title="Message">
                  <p className="codex-request-copy">{request.message}</p>
                </RequestSection>

                {request.mode === "url" ? (
                  <RequestSection title="URL">
                    <a className="codex-request-link" href={request.url} rel="noreferrer" target="_blank">
                      {request.url}
                    </a>
                  </RequestSection>
                ) : (
                  <>
                    <RequestSection title="Requested schema">
                      <pre className="codex-request-code">{prettyJson(request.requestedSchema)}</pre>
                    </RequestSection>

                    <RequestSection title="Response JSON">
                      <textarea
                        className="codex-request-textarea"
                        disabled={isSubmitting}
                        rows={8}
                        value={mcpContent}
                        onChange={(event) => setMcpContent(event.target.value)}
                      />
                    </RequestSection>
                  </>
                )}

                <div className="codex-request-actions">
                  <button className="action-button" disabled={isSubmitting} type="button" onClick={() => void submitMcpAccept()}>
                    Accept
                  </button>
                  <button
                    className="ghost-button ghost-button--danger"
                    disabled={isSubmitting}
                    type="button"
                    onClick={() =>
                      void respond({
                        type: "mcp_elicitation",
                        action: "decline",
                        content: null,
                        meta: request.meta
                      })
                    }
                  >
                    Decline
                  </button>
                  <button
                    className="ghost-button"
                    disabled={isSubmitting}
                    type="button"
                    onClick={() =>
                      void respond({
                        type: "mcp_elicitation",
                        action: "cancel",
                        content: null,
                        meta: request.meta
                      })
                    }
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : null}

            {localError || submitError ? <p className="codex-request-error">{localError ?? submitError}</p> : null}
          </div>
        </div>
      </div>
    </FloatingPortal>
  );
}
