import fs from "node:fs";
import path from "node:path";

export type RuntimeState = {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
  tailscale: {
    enabled: boolean;
    url: string | null;
    backupFile: string | null;
  };
};

export function readRuntimeState(filePath: string): RuntimeState | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<RuntimeState> | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      port: typeof parsed.port === "number" ? parsed.port : 0,
      host: typeof parsed.host === "string" ? parsed.host : "127.0.0.1",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      tailscale: {
        enabled: Boolean(parsed.tailscale?.enabled),
        url: typeof parsed.tailscale?.url === "string" ? parsed.tailscale.url : null,
        backupFile: typeof parsed.tailscale?.backupFile === "string" ? parsed.tailscale.backupFile : null
      }
    };
  } catch {
    return null;
  }
}

export function writeRuntimeState(filePath: string, state: RuntimeState) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function clearRuntimeState(filePath: string) {
  fs.rmSync(filePath, { force: true });
}
