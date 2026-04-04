import type { LoggerLike } from "./types";
import { MockCodexClient } from "./mock-client";
import { RealCodexClient } from "./real-client";
import type { CodexDebugLog } from "../observability/codex-debug-log";

export async function createCodexBackend(
  mode: "auto" | "real" | "mock",
  logger: LoggerLike,
  debugLog?: CodexDebugLog,
  codexHomeDir?: string
) {
  debugLog?.write("backend.select", { requestedMode: mode });

  if (mode === "mock") {
    const mock = new MockCodexClient(logger);
    await mock.start();
    debugLog?.write("backend.ready", { mode: "mock" });
    return mock;
  }

  const real = new RealCodexClient(logger, debugLog, codexHomeDir);
  try {
    await real.start();
    debugLog?.write("backend.ready", { mode: "real" });
    return real;
  } catch (error) {
    if (mode === "real") {
      debugLog?.write("backend.start_failed", {
        mode: "real",
        error
      });
      throw error;
    }

    logger.warn(
      `Falling back to mock Codex backend: ${error instanceof Error ? error.message : String(error)}`
    );
    debugLog?.write("backend.fallback_to_mock", {
      requestedMode: mode,
      error
    });
    const mock = new MockCodexClient(logger);
    await mock.start();
    debugLog?.write("backend.ready", { mode: "mock" });
    return mock;
  }
}
