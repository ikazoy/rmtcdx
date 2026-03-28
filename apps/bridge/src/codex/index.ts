import type { LoggerLike } from "./types";
import { MockCodexClient } from "./mock-client";
import { RealCodexClient } from "./real-client";

export async function createCodexBackend(
  mode: "auto" | "real" | "mock",
  logger: LoggerLike
) {
  if (mode === "mock") {
    const mock = new MockCodexClient(logger);
    await mock.start();
    return mock;
  }

  const real = new RealCodexClient(logger);
  try {
    await real.start();
    return real;
  } catch (error) {
    if (mode === "real") {
      throw error;
    }

    logger.warn(
      `Falling back to mock Codex backend: ${error instanceof Error ? error.message : String(error)}`
    );
    const mock = new MockCodexClient(logger);
    await mock.start();
    return mock;
  }
}
