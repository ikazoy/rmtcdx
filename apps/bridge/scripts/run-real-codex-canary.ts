import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

import type { CodexPendingRequest, CodexPendingRequestResponse } from "@codex-remote/shared-types";
import type { CanaryScenarioSummary, CanaryWorkspaceCheck } from "../src/compat/canary-report";
import { summarizeCanaryRun, summarizeCanaryScenario, type CanaryScenarioExpectation } from "../src/compat/canary-report";
import { loadConfig } from "../src/config/env";
import { RealCodexClient } from "../src/codex/real-client";
import type { CodexBridgeEvent, LoggerLike } from "../src/codex/types";
import { CodexDebugLog } from "../src/observability/codex-debug-log";

const execFileAsync = promisify(execFile);

type CanaryScenarioDefinition = {
  id: string;
  description: string;
  prompt: string;
  expectations: CanaryScenarioExpectation;
  setupFiles: Record<string, string>;
  mode: "normal" | "interrupt";
  workspaceChecks?: Array<{ path: string; includes: string }>;
};

const scenariosById: Record<string, CanaryScenarioDefinition> = {
  "basic-text": {
    id: "basic-text",
    description: "Minimal text-only thread sanity check.",
    prompt: [
      "This is a Codex compatibility canary.",
      "Reply with the exact text compat-basic-ok in your final answer.",
      "Do not edit files."
    ].join("\n"),
    expectations: {
      requiredTerminalEvent: "run.completed",
      finalTextIncludes: "compat-basic-ok"
    },
    setupFiles: {
      "README.md": "# Canary Repo\n\nThis repository is used for real Codex compatibility checks.\n"
    },
    mode: "normal"
  },
  "tool-edit": {
    id: "tool-edit",
    description: "Checks command execution and file change items in a disposable repo.",
    prompt: [
      "This is a Codex compatibility canary.",
      "Use shell to inspect notes.txt, then append a new line compat-tool-ok to notes.txt.",
      "Use apply_patch or another file editing tool for the file change.",
      "In your final answer include the exact text compat-tool-ok."
    ].join("\n"),
    expectations: {
      requiredTerminalEvent: "run.completed",
      finalTextIncludes: "compat-tool-ok",
      requiredItemTypes: ["commandExecution", "fileChange"]
    },
    setupFiles: {
      "README.md": "# Canary Repo\n",
      "notes.txt": "initial-line\n"
    },
    mode: "normal",
    workspaceChecks: [
      {
        path: "notes.txt",
        includes: "compat-tool-ok"
      }
    ]
  },
  interrupt: {
    id: "interrupt",
    description: "Checks that a long-running turn can be interrupted cleanly.",
    prompt: [
      "This is a Codex compatibility canary.",
      "Produce a long response by counting from 1 to 200 with one number per line.",
      "Do not summarize."
    ].join("\n"),
    expectations: {
      requiredTerminalEvent: "run.interrupted"
    },
    setupFiles: {
      "README.md": "# Canary Repo\n"
    },
    mode: "interrupt"
  }
};

const { values } = parseArgs({
  options: {
    scenario: {
      type: "string",
      multiple: true
    },
    outputDir: {
      type: "string"
    },
    timeoutMs: {
      type: "string"
    },
    strictDrift: {
      type: "boolean"
    },
    help: {
      type: "boolean"
    }
  }
});

if (values.help) {
  printHelp();
  process.exit(0);
}

const selectedScenarioIds = normalizeScenarioIds(values.scenario);
const timeoutMs = Number(values.timeoutMs ?? 90_000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error(`Invalid timeout: ${values.timeoutMs ?? "<empty>"}`);
}

const config = loadConfig();
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.resolve(values.outputDir ?? path.join(config.dataDir, "compat", "real-codex-canary", timestamp));
const workspacesDir = path.join(outputDir, "workspaces");
const debugLogFile = path.join(outputDir, "codex-app-server.jsonl");

await fs.mkdir(workspacesDir, { recursive: true });

const logger = createLogger();
const debugLog = new CodexDebugLog(debugLogFile, {
  runner: "real-codex-canary"
});
const codex = new RealCodexClient(logger, debugLog);

let exitCode = 0;

try {
  const codexVersion = await readCodexVersion();
  await codex.start();

  const scenarioSummaries: CanaryScenarioSummary[] = [];

  for (const scenarioId of selectedScenarioIds) {
    const definition = scenariosById[scenarioId];
    if (!definition) {
      throw new Error(`Unknown scenario: ${scenarioId}`);
    }

    logger.info(`Running scenario ${definition.id}: ${definition.description}`);
    const summary = await runScenario(codex, definition, {
      timeoutMs,
      workspacesDir,
      outputDir
    });
    scenarioSummaries.push(summary);
    logger.info(`Scenario ${definition.id} finished with status ${summary.status}`);
  }

  const notificationInventory = await readNotificationInventory(debugLogFile);
  const report = {
    startedAt: new Date().toISOString(),
    codexVersion,
    outputDir,
    debugLogFile,
    notificationInventory,
    ...summarizeCanaryRun(scenarioSummaries)
  };

  const reportPath = path.join(outputDir, "report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  logger.info(`Canary report written to ${reportPath}`);
  logger.info(`Overall status: ${report.status}`);

  if (report.status === "fail") {
    exitCode = 1;
  } else if (report.status === "pass_with_drift" && values.strictDrift) {
    exitCode = 2;
  }
} finally {
  await codex.stop().catch((error: unknown) => {
    logger.warn(`Failed to stop Codex client cleanly: ${error instanceof Error ? error.message : String(error)}`);
  });
  debugLog.close();
}

process.exit(exitCode);

async function runScenario(
  codex: RealCodexClient,
  definition: CanaryScenarioDefinition,
  options: { timeoutMs: number; workspacesDir: string; outputDir: string }
) {
  const workspaceDir = path.join(options.workspacesDir, definition.id);
  const artifactDir = path.join(options.outputDir, definition.id);
  await fs.rm(workspaceDir, { recursive: true, force: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(artifactDir, { recursive: true });
  await writeScenarioFiles(workspaceDir, definition.setupFiles);
  await initializeGitRepo(workspaceDir);
  await fs.writeFile(path.join(artifactDir, "prompt.txt"), `${definition.prompt}\n`, "utf8");

  const runId = `canary_run_${definition.id}_${randomUUID()}`;
  let threadId: string | null = null;
  const bridgeEvents: CodexBridgeEvent[] = [];
  const requestArtifacts: Array<{ type: "created" | "resolved" | "response_error"; payload: unknown }> = [];
  const requestResponsePromises: Promise<unknown>[] = [];
  const onEvent = (event: CodexBridgeEvent) => {
    if (event.type === "request.created") {
      bridgeEvents.push(event);
      requestArtifacts.push({ type: "created", payload: event.request });
      requestResponsePromises.push(autoResolveRequest(codex, event.request, requestArtifacts));
      return;
    }

    if (event.type === "request.resolved") {
      bridgeEvents.push(event);
      requestArtifacts.push({ type: "resolved", payload: { requestId: event.requestId, sessionId: event.sessionId } });
      return;
    }

    if ("runId" in event && event.runId === runId) {
      bridgeEvents.push(event);
      return;
    }

    if ("sessionId" in event && threadId && event.sessionId === threadId) {
      bridgeEvents.push(event);
      return;
    }

    if (event.type === "backend.degraded") {
      bridgeEvents.push(event);
    }
  };
  codex.on("event", onEvent);

  try {
    const started = await codex.startRun({
      runId,
      cwd: workspaceDir,
      input: [
        {
          type: "text",
          text: definition.prompt,
          text_elements: []
        }
      ]
    });
    threadId = started.threadId;

    if (definition.mode === "interrupt") {
      await waitForFirstProgressEvent(runId, bridgeEvents, codex, options.timeoutMs);
      await codex.interruptRun(runId, started.threadId, started.turnId);
    }

    await waitForTerminalEvent(runId, bridgeEvents, codex, options.timeoutMs);
    await Promise.allSettled(requestResponsePromises);
    const thread = await codex.readThread(started.threadId, { includeTurns: true });
    const workspaceChecks = await runWorkspaceChecks(workspaceDir, definition.workspaceChecks);
    const summary = summarizeCanaryScenario({
      scenarioId: definition.id,
      thread,
      bridgeEvents,
      expectations: definition.expectations,
      workspaceChecks
    });

    await fs.writeFile(path.join(artifactDir, "thread-read.json"), `${JSON.stringify({ thread }, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(artifactDir, "bridge-events.jsonl"), toJsonLines(bridgeEvents), "utf8");
    await fs.writeFile(path.join(artifactDir, "requests.jsonl"), toJsonLines(requestArtifacts), "utf8");
    await fs.writeFile(path.join(artifactDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    return summary;
  } finally {
    codex.off("event", onEvent);
  }
}

async function writeScenarioFiles(rootDir: string, files: Record<string, string>) {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }
}

async function initializeGitRepo(rootDir: string) {
  try {
    await execFileAsync("git", ["init", "-b", "main", rootDir]);
  } catch {
    await execFileAsync("git", ["init", rootDir]);
  }
}

async function waitForFirstProgressEvent(
  runId: string,
  bridgeEvents: CodexBridgeEvent[],
  codex: RealCodexClient,
  timeoutMs: number
) {
  const alreadyObserved = bridgeEvents.some(
    (event) =>
      "runId" in event
      && event.runId === runId
      && (event.type === "item.delta" || event.type === "activity.started" || event.type === "activity.updated")
  );
  if (alreadyObserved) {
    return;
  }

  await waitForEvent(
    codex,
    (event) =>
      "runId" in event
      && event.runId === runId
      && (event.type === "item.delta" || event.type === "activity.started" || event.type === "activity.updated"),
    Math.max(2_000, Math.min(timeoutMs, 15_000))
  ).catch(() => {
    // If no progress event arrives, interrupt anyway to exercise the interrupt path.
  });
}

async function waitForTerminalEvent(
  runId: string,
  bridgeEvents: CodexBridgeEvent[],
  codex: RealCodexClient,
  timeoutMs: number
) {
  const terminal = bridgeEvents.find(
    (event) =>
      event.type === "backend.degraded"
      || (
        "runId" in event
        && event.runId === runId
        && (event.type === "run.completed" || event.type === "run.interrupted" || event.type === "run.error")
      )
  );
  if (terminal) {
    return terminal;
  }

  return waitForEvent(
    codex,
    (event) =>
      event.type === "backend.degraded"
      || (
        "runId" in event
        && event.runId === runId
        && (event.type === "run.completed" || event.type === "run.interrupted" || event.type === "run.error")
      ),
    timeoutMs
  );
}

function waitForEvent(
  codex: RealCodexClient,
  predicate: (event: CodexBridgeEvent) => boolean,
  timeoutMs: number
) {
  return new Promise<CodexBridgeEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      codex.off("event", onEvent);
      reject(new Error(`Timed out waiting for event after ${timeoutMs}ms`));
    }, timeoutMs);

    const onEvent = (event: CodexBridgeEvent) => {
      if (!predicate(event)) {
        return;
      }
      clearTimeout(timer);
      codex.off("event", onEvent);
      resolve(event);
    };

    codex.on("event", onEvent);
  });
}

async function runWorkspaceChecks(
  workspaceDir: string,
  checks: Array<{ path: string; includes: string }> | undefined
): Promise<CanaryWorkspaceCheck[]> {
  if (!checks?.length) {
    return [];
  }

  return Promise.all(
    checks.map(async (check) => {
      const filePath = path.join(workspaceDir, check.path);
      try {
        const content = await fs.readFile(filePath, "utf8");
        return {
          path: check.path,
          ok: content.includes(check.includes),
          details: content.includes(check.includes) ? undefined : `Expected file to contain "${check.includes}".`
        } satisfies CanaryWorkspaceCheck;
      } catch (error) {
        return {
          path: check.path,
          ok: false,
          details: error instanceof Error ? error.message : String(error)
        } satisfies CanaryWorkspaceCheck;
      }
    })
  );
}

async function readCodexVersion() {
  const { stdout, stderr } = await execFileAsync("codex", ["--version"]);
  return (stdout || stderr).trim();
}

async function readNotificationInventory(debugLogFile: string) {
  try {
    const contents = await fs.readFile(debugLogFile, "utf8");
    const entries = contents
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: string; method?: string });

    return {
      receivedMethods: [
        ...new Set(entries.filter((entry) => entry.event === "notification.received").map((entry) => entry.method).filter(isString))
      ].sort(),
      unhandledMethods: [
        ...new Set(entries.filter((entry) => entry.event === "notification.unhandled").map((entry) => entry.method).filter(isString))
      ].sort()
    };
  } catch {
    return {
      receivedMethods: [],
      unhandledMethods: []
    };
  }
}

async function autoResolveRequest(
  codex: RealCodexClient,
  request: CodexPendingRequest,
  requestArtifacts: Array<{ type: "created" | "resolved" | "response_error"; payload: unknown }>
) {
  const response = responseForRequest(request);
  if (!response) {
    requestArtifacts.push({
      type: "response_error",
      payload: {
        requestId: request.id,
        message: `No auto-response strategy for ${request.type}.`
      }
    });
    return;
  }

  try {
    await codex.respondToRequest(request.id, response);
  } catch (error) {
    requestArtifacts.push({
      type: "response_error",
      payload: {
        requestId: request.id,
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

function responseForRequest(request: CodexPendingRequest): CodexPendingRequestResponse | null {
  if (request.type === "command_approval") {
    return {
      type: request.type,
      decision: request.availableDecisions.includes("acceptForSession") ? "acceptForSession" : "accept"
    };
  }

  if (request.type === "file_change_approval") {
    return {
      type: request.type,
      decision: "acceptForSession"
    };
  }

  if (request.type === "permissions_approval") {
    return {
      type: request.type,
      permissions: {
        network: request.permissions.network ?? undefined,
        fileSystem: request.permissions.fileSystem ?? undefined
      },
      scope: "session"
    };
  }

  if (request.type === "request_user_input") {
    return {
      type: request.type,
      answers: Object.fromEntries(
        request.questions.map((question) => [
          question.id,
          {
            answers: question.options?.[0]?.label ? [question.options[0].label] : ["canary"]
          }
        ])
      )
    };
  }

  if (request.type === "mcp_elicitation") {
    return {
      type: request.type,
      action: "decline",
      content: null,
      meta: null
    };
  }

  return null;
}

function normalizeScenarioIds(input: string[] | undefined) {
  const raw = input?.flatMap((value) => value.split(",").map((entry) => entry.trim()).filter(Boolean)) ?? [];
  if (raw.length === 0) {
    return ["basic-text", "tool-edit", "interrupt"];
  }
  return raw;
}

function toJsonLines(entries: unknown[]) {
  return entries.map((entry) => JSON.stringify(entry)).join("\n").concat(entries.length ? "\n" : "");
}

function createLogger(): LoggerLike {
  return {
    info: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console)
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function printHelp() {
  process.stdout.write(
    [
      "Run real Codex compatibility canaries and save artifacts.",
      "",
      "Options:",
      "  --scenario <id>     Scenario id to run. Can be passed multiple times or as a comma-separated list.",
      "  --outputDir <path>  Artifact directory. Defaults to DATA_DIR/compat/real-codex-canary/<timestamp>.",
      "  --timeoutMs <ms>    Per-scenario timeout. Defaults to 90000.",
      "  --strictDrift       Exit non-zero when drift is observed without a hard failure.",
      "  --help              Show this message."
    ].join("\n")
  );
}
