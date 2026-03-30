import fs from "node:fs";
import path from "node:path";

type DebugFields = Record<string, unknown> | undefined;
type DebugContext = Record<string, unknown>;

function normalizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry)]));
}

function normalizeFields(fields: DebugFields): Record<string, unknown> {
  if (!fields) {
    return {};
  }
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, normalizeValue(value)]));
}

export class CodexDebugLog {
  private readonly stream: fs.WriteStream;

  constructor(
    readonly filePath: string,
    private readonly context: DebugContext = {}
  ) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = fs.createWriteStream(filePath, {
      flags: "a",
      encoding: "utf8"
    });
    this.stream.on("error", (error) => {
      process.stderr.write(`[codex-debug-log] ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }

  write(event: string, fields?: DebugFields) {
    const payload = {
      timestamp: new Date().toISOString(),
      source: "codex-app-server",
      ...normalizeFields(this.context),
      event,
      ...normalizeFields(fields)
    };
    this.stream.write(`${JSON.stringify(payload)}\n`);
  }

  close() {
    this.stream.end();
  }
}
