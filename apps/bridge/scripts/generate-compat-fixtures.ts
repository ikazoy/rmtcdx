import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

type JsonObject = Record<string, unknown>;

type ScenarioContext = {
  scenarioId: string;
  fixtureName: string;
  threadPath: string;
  bridgeEventsPath: string;
  requestsPath: string;
  rawThreadPayload: JsonObject;
  rawIdentifiers: Set<string>;
  replacements: Array<[from: string, to: string]>;
};

type ReportShape = {
  codexVersion?: string;
};

const scenarioNameMap: Record<string, string> = {
  "basic-text": "basic",
  "tool-edit": "tool-edit",
  interrupt: "interrupt"
};

const { values } = parseArgs({
  options: {
    artifactDir: {
      type: "string"
    },
    outputDir: {
      type: "string"
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

const artifactDir = path.resolve(values.artifactDir ?? (await findLatestArtifactDir()));
const report = await readJsonOptional(path.join(artifactDir, "report.json"));
const fixtureRoot = path.resolve(
  values.outputDir ?? path.join("apps/bridge/test/codex-compat/fixtures", normalizeVersionDir(report), "real-canary")
);

const contexts = await loadScenarioContexts(artifactDir);
const warnings: string[] = [];
await fs.mkdir(fixtureRoot, { recursive: true });

for (const context of contexts) {
  await writeSanitizedJson(path.join(fixtureRoot, `thread-read-${context.fixtureName}.json`), context.rawThreadPayload, context);

  const bridgeEvents = await readJsonLines(context.bridgeEventsPath).catch(() => [] as JsonObject[]);
  if (bridgeEvents.length > 0) {
    await writeJsonLines(
      path.join(fixtureRoot, `bridge-events-${context.fixtureName}.jsonl`),
      bridgeEvents
        .filter((entry) => entry.type !== "message.delta")
        .map((entry) => sanitizeValue(entry, context))
    );
  }

  const requests = await readJsonLines(context.requestsPath);
  if (requests.length > 0) {
    await writeJsonLines(
      path.join(fixtureRoot, `requests-${context.fixtureName}.jsonl`),
      requests.map((entry) => sanitizeValue(entry, context))
    );
  }
}

const notifications = await extractNotificationsByScenario(path.join(artifactDir, "codex-app-server.jsonl"), contexts);
for (const [fixtureName, entries] of notifications.files) {
  if (entries.length > 0) {
    await writeJsonLines(path.join(fixtureRoot, `notifications-${fixtureName}.jsonl`), entries);
  }
}
warnings.push(...notifications.warnings);

await fs.writeFile(
  path.join(fixtureRoot, "manifest.json"),
  `${JSON.stringify(
    {
      sourceArtifactDir: path.relative(process.cwd(), artifactDir) || ".",
      codexVersion: report?.codexVersion ?? null,
      generatedAt: new Date().toISOString(),
      scenarios: contexts.map((context) => ({
        scenarioId: context.scenarioId,
        fixtureName: context.fixtureName
      })),
      warnings
    },
    null,
    2
  )}\n`,
  "utf8"
);

process.stdout.write(`Generated sanitized fixtures in ${fixtureRoot}\n`);
if (warnings.length > 0) {
  process.stdout.write(`${warnings.map((warning) => `warning: ${warning}`).join("\n")}\n`);
}

async function loadScenarioContexts(artifactRoot: string): Promise<ScenarioContext[]> {
  const entries = await fs.readdir(artifactRoot, { withFileTypes: true });
  const contexts: ScenarioContext[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "workspaces") {
      continue;
    }

    const threadPath = path.join(artifactRoot, entry.name, "thread-read.json");
    const bridgeEventsPath = path.join(artifactRoot, entry.name, "bridge-events.jsonl");
    const requestsPath = path.join(artifactRoot, entry.name, "requests.jsonl");

    try {
      await fs.access(threadPath);
    } catch {
      continue;
    }

    const rawThreadPayload = (await readJson(threadPath)) as JsonObject;
    const fixtureName = scenarioNameMap[entry.name] ?? entry.name;
    const rawIdentifiers = new Set<string>();
    const replacements: Array<[string, string]> = [];

    const thread = asObject(rawThreadPayload.thread);
    const threadId = stringField(thread, "id");
    const threadCwd = stringField(thread, "cwd");
    if (threadId) {
      rawIdentifiers.add(threadId);
      replacements.push([threadId, `thread_${fixtureName}`]);
    }
    if (threadCwd) {
      replacements.push([threadCwd, `/fixtures/workspaces/${entry.name}`]);
    }

    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    turns.forEach((turn, turnIndex) => {
      const turnPayload = asObject(turn);
      const turnId = stringField(turnPayload, "id");
      if (turnId) {
        rawIdentifiers.add(turnId);
        replacements.push([turnId, `turn_${fixtureName}_${turnIndex + 1}`]);
      }

      const items = Array.isArray(turnPayload?.items) ? turnPayload.items : [];
      items.forEach((item, itemIndex) => {
        const itemId = stringField(asObject(item), "id");
        if (!itemId) {
          return;
        }
        rawIdentifiers.add(itemId);
        replacements.push([itemId, `item_${fixtureName}_${turnIndex + 1}_${itemIndex + 1}`]);
      });
    });

    for (const runId of await collectRunIds(bridgeEventsPath)) {
      replacements.push([runId, `run_${fixtureName}`]);
    }

    for (const requestId of await collectRequestIds(requestsPath)) {
      replacements.push([requestId, `request_${fixtureName}`]);
    }

    contexts.push({
      scenarioId: entry.name,
      fixtureName,
      threadPath,
      bridgeEventsPath,
      requestsPath,
      rawThreadPayload,
      rawIdentifiers,
      replacements
    });
  }

  return contexts;
}

async function extractNotificationsByScenario(debugLogPath: string, contexts: ScenarioContext[]) {
  const files = new Map<string, Array<{ method: string; params: unknown }>>();
  const warnings: string[] = [];

  for (const context of contexts) {
    files.set(context.fixtureName, []);
  }

  let lines: JsonObject[] = [];
  try {
    lines = await readJsonLines(debugLogPath);
  } catch {
    warnings.push(`Debug log was not found at ${debugLogPath}.`);
    return { files, warnings };
  }

  const notificationLines = lines.filter(
    (entry) => entry.event === "notification.received" && typeof entry.method === "string"
  );
  const hasParams = notificationLines.some((entry) => entry.params !== undefined);
  if (!hasParams) {
    warnings.push("notification.received entries do not include params yet; rerun real canary after updating debug logging.");
    return { files, warnings };
  }

  for (const entry of notificationLines) {
    const method = typeof entry.method === "string" ? entry.method : null;
    if (!method || entry.params === undefined) {
      continue;
    }

    for (const context of contexts) {
      if (!containsScenarioIdentifier(entry.params, context.rawIdentifiers)) {
        continue;
      }

      files.get(context.fixtureName)?.push({
        method,
        params: sanitizeValue(entry.params, context)
      });
      break;
    }
  }

  return { files, warnings };
}

async function collectRunIds(filePath: string) {
  const lines = await readJsonLines(filePath).catch(() => [] as JsonObject[]);
  const runIds = new Set<string>();

  for (const line of lines) {
    collectValuesForKey(line, "runId", runIds);
  }

  return [...runIds];
}

async function collectRequestIds(filePath: string) {
  const lines = await readJsonLines(filePath).catch(() => [] as JsonObject[]);
  const requestIds = new Set<string>();

  for (const line of lines) {
    const type = typeof line.type === "string" ? line.type : null;
    const payload = asObject(line.payload);
    if (type === "created") {
      const id = stringField(payload, "id");
      if (id) {
        requestIds.add(id);
      }
      continue;
    }

    if (type === "resolved") {
      const requestId = stringField(payload, "requestId");
      if (requestId) {
        requestIds.add(requestId);
      }
    }
  }

  return [...requestIds];
}

async function writeSanitizedJson(outputPath: string, value: unknown, context: ScenarioContext) {
  await fs.writeFile(outputPath, `${JSON.stringify(sanitizeValue(value, context), null, 2)}\n`, "utf8");
}

async function writeJsonLines(outputPath: string, lines: unknown[]) {
  const contents = lines.map((line) => JSON.stringify(line)).join("\n");
  await fs.writeFile(outputPath, contents ? `${contents}\n` : "", "utf8");
}

function sanitizeValue(value: unknown, context: ScenarioContext): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, context));
  }

  if (!value || typeof value !== "object") {
    return typeof value === "string" ? sanitizeString(value, context) : value;
  }

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry, context)]));
}

function sanitizeString(value: string, context: ScenarioContext) {
  let next = value;
  for (const [from, to] of context.replacements.sort((left, right) => right[0].length - left[0].length)) {
    next = next.split(from).join(to);
  }
  next = next.replace(/\/Users\/[^/]+\/\.codex\/sessions\/[^"\s]+/g, `/fixtures/codex/sessions/${context.fixtureName}.jsonl`);
  next = next.replace(/\/Users\/[^/]+/g, "/Users/canary");
  return next;
}

function containsScenarioIdentifier(value: unknown, identifiers: Set<string>): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsScenarioIdentifier(entry, identifiers));
  }

  if (!value || typeof value !== "object") {
    return typeof value === "string" ? identifiers.has(value) : false;
  }

  return Object.values(value).some((entry) => containsScenarioIdentifier(entry, identifiers));
}

async function readJsonLines(filePath: string): Promise<JsonObject[]> {
  const contents = await fs.readFile(filePath, "utf8");
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonObject);
}

async function readJson(filePath: string) {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

async function readJsonOptional(filePath: string): Promise<ReportShape | null> {
  try {
    return (await readJson(filePath)) as ReportShape;
  } catch {
    return null;
  }
}

async function findLatestArtifactDir() {
  const root = path.resolve("data/compat/real-codex-canary");
  const entries = await fs.readdir(root, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const latest = directories.at(-1);
  if (!latest) {
    throw new Error(`No real canary artifacts found in ${root}`);
  }
  return path.join(root, latest);
}

function normalizeVersionDir(report: ReportShape | null) {
  const match = report?.codexVersion?.match(/(\d+\.\d+\.\d+)/);
  return match ? `codex-cli-${match[1]}` : "codex-cli-real-canary";
}

function collectValuesForKey(value: unknown, key: string, out: Set<string>) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectValuesForKey(entry, key, out));
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key && typeof entryValue === "string") {
      out.add(entryValue);
    }
    collectValuesForKey(entryValue, key, out);
  }
}

function asObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function stringField(value: JsonObject | null | undefined, key: string) {
  const field = value?.[key];
  return typeof field === "string" ? field : null;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: tsx scripts/generate-compat-fixtures.ts [--artifactDir <dir>] [--outputDir <dir>]",
      "",
      "Reads a real Codex canary artifact directory and writes sanitized compatibility fixtures.",
      "If --artifactDir is omitted, the latest data/compat/real-codex-canary/<timestamp> directory is used."
    ].join("\n")
  );
}
