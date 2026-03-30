import type { CodexBridgeEvent, CodexThread } from "../codex/types";

export type CanaryScenarioStatus = "pass" | "pass_with_drift" | "fail";

export type CanaryWorkspaceCheck = {
  path: string;
  ok: boolean;
  details?: string;
};

export type CanaryScenarioExpectation = {
  requiredTerminalEvent?: "run.completed" | "run.interrupted" | "run.error";
  finalTextIncludes?: string;
  requiredItemTypes?: string[];
};

export type CanaryScenarioSummary = {
  scenarioId: string;
  status: CanaryScenarioStatus;
  terminalEventType: CodexBridgeEvent["type"] | null;
  threadStatus: CodexThread["status"]["type"];
  turnStatus: CodexThread["turns"][number]["status"] | null;
  bridgeEventTypes: string[];
  itemTypes: string[];
  unknownItemTypes: string[];
  finalAssistantText: string | null;
  failedAssertions: string[];
  workspaceChecks: CanaryWorkspaceCheck[];
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

export function summarizeCanaryScenario(params: {
  scenarioId: string;
  thread: CodexThread;
  bridgeEvents: CodexBridgeEvent[];
  expectations: CanaryScenarioExpectation;
  workspaceChecks?: CanaryWorkspaceCheck[];
}): CanaryScenarioSummary {
  const latestTurn = params.thread.turns.at(-1) ?? null;
  const assistantMessages =
    latestTurn?.items.filter(
      (item): item is Extract<CodexThread["turns"][number]["items"][number], { type: "agentMessage" }> =>
        item.type === "agentMessage"
    ) ?? [];
  const finalAssistantText = assistantMessages.at(-1)?.text ?? null;
  const itemTypes = [...new Set(params.thread.turns.flatMap((turn) => turn.items.map((item) => item.type)))].sort();
  const unknownItemTypes = itemTypes.filter((type) => !knownThreadItemTypes.has(type));
  const bridgeEventTypes = [...new Set(params.bridgeEvents.map((event) => event.type))].sort();
  const terminalEventType = [...params.bridgeEvents]
    .reverse()
    .find(
      (event) =>
        event.type === "run.completed"
        || event.type === "run.interrupted"
        || event.type === "run.error"
        || event.type === "backend.degraded"
    )?.type ?? null;

  const failedAssertions: string[] = [];

  if (params.expectations.requiredTerminalEvent && terminalEventType !== params.expectations.requiredTerminalEvent) {
    failedAssertions.push(
      `Expected terminal event ${params.expectations.requiredTerminalEvent} but received ${terminalEventType ?? "none"}.`
    );
  }

  if (params.expectations.finalTextIncludes && !finalAssistantText?.includes(params.expectations.finalTextIncludes)) {
    failedAssertions.push(`Final assistant message did not include "${params.expectations.finalTextIncludes}".`);
  }

  for (const requiredItemType of params.expectations.requiredItemTypes ?? []) {
    if (!itemTypes.includes(requiredItemType)) {
      failedAssertions.push(`Expected item type ${requiredItemType} but it was not observed.`);
    }
  }

  for (const check of params.workspaceChecks ?? []) {
    if (!check.ok) {
      failedAssertions.push(`Workspace check failed for ${check.path}: ${check.details ?? "unknown failure"}`);
    }
  }

  return {
    scenarioId: params.scenarioId,
    status:
      failedAssertions.length > 0
        ? "fail"
        : unknownItemTypes.length > 0
          ? "pass_with_drift"
          : "pass",
    terminalEventType,
    threadStatus: params.thread.status.type,
    turnStatus: latestTurn?.status ?? null,
    bridgeEventTypes,
    itemTypes,
    unknownItemTypes,
    finalAssistantText,
    failedAssertions,
    workspaceChecks: params.workspaceChecks ?? []
  };
}

export function summarizeCanaryRun(scenarios: CanaryScenarioSummary[]) {
  const status = scenarios.some((scenario) => scenario.status === "fail")
    ? "fail"
    : scenarios.some((scenario) => scenario.status === "pass_with_drift")
      ? "pass_with_drift"
      : "pass";

  return {
    status,
    scenarios
  } as const;
}
