#!/usr/bin/env node

import fs from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { buildApp } from "./app";
import { parseCliArgs, CLI_HELP } from "./cli/args";
import { preferredPrivateIpv4 } from "./cli/network";
import { clearRuntimeState, readRuntimeState, writeRuntimeState, type RuntimeState } from "./cli/runtime-state";
import { enableTailscaleServe, ensureTailscaleAvailable, restoreTailscaleServe } from "./cli/tailscale";
import { loadConfig } from "./config/env";

const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 150;

try {
  const command = parseCliArgs(process.argv.slice(2));

  if (command.name === "help") {
    process.stdout.write(CLI_HELP);
    process.exit(0);
  }

  if (command.name === "serve") {
    await runServeCommand();
  } else if (command.name === "up") {
    await runUpCommand(command.tailscale);
    process.exit(0);
  } else if (command.name === "stop") {
    await runStopCommand();
    process.exit(0);
  } else {
    await runStatusCommand();
    process.exit(0);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

async function runServeCommand() {
  const { app, config } = await buildApp();
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    app.log.info({ signal }, "Shutting down bridge");

    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error(error);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  try {
    await app.listen({
      port: config.port,
      host: config.host
    });
    app.log.info(`Bridge listening on http://${config.host}:${config.port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

async function runUpCommand(tailscale: boolean) {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });

  const existing = readRuntimeState(config.runtimeFile);
  if (existing && existing.pid > 0 && isProcessRunning(existing.pid)) {
    if (tailscale && !existing.tailscale.enabled) {
      const tailscaleState = enableTailscaleServe({
        port: existing.port,
        dataDir: config.dataDir
      });

      const nextState: RuntimeState = {
        ...existing,
        tailscale: {
          enabled: true,
          url: tailscaleState.url,
          backupFile: tailscaleState.backupFile
        }
      };

      writeRuntimeState(config.runtimeFile, nextState);
      printStartupSummary(nextState, true);
      return;
    }

    printStartupSummary(existing, true);
    return;
  }

  if (existing) {
    clearRuntimeArtifacts(existing, config.runtimeFile);
  }

  if (tailscale) {
    ensureTailscaleAvailable();
  }

  const child = spawn(process.execPath, childCommandArgs(), {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      HOST: "0.0.0.0"
    },
    stdio: "ignore",
    windowsHide: true
  });

  if (!child.pid) {
    throw new Error("Unable to determine the background process ID.");
  }

  child.unref();

  try {
    await waitForServerReady(config.port, child.pid, START_TIMEOUT_MS);
  } catch (error) {
    safeKill(child.pid);
    throw error;
  }

  let runtimeState: RuntimeState = {
    pid: child.pid,
    port: config.port,
    host: "0.0.0.0",
    startedAt: new Date().toISOString(),
    tailscale: {
      enabled: false,
      url: null,
      backupFile: null
    }
  };

  if (tailscale) {
    try {
      const tailscaleState = enableTailscaleServe({
        port: config.port,
        dataDir: config.dataDir
      });
      runtimeState = {
        ...runtimeState,
        tailscale: {
          enabled: true,
          url: tailscaleState.url,
          backupFile: tailscaleState.backupFile
        }
      };
    } catch (error) {
      await stopProcess(child.pid, STOP_TIMEOUT_MS);
      throw error;
    }
  }

  writeRuntimeState(config.runtimeFile, runtimeState);
  printStartupSummary(runtimeState, false);
}

async function runStopCommand() {
  const config = loadConfig();
  const runtimeState = readRuntimeState(config.runtimeFile);

  if (!runtimeState) {
    process.stdout.write("rmtcdx is not running.\n");
    return;
  }

  const running = runtimeState.pid > 0 && isProcessRunning(runtimeState.pid);
  if (running) {
    await stopProcess(runtimeState.pid, STOP_TIMEOUT_MS);
  }

  if (runtimeState.tailscale.enabled && runtimeState.tailscale.backupFile) {
    try {
      restoreTailscaleServe(runtimeState.tailscale.backupFile);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  clearRuntimeArtifacts(runtimeState, config.runtimeFile);
  process.stdout.write("rmtcdx has stopped.\n");
}

async function runStatusCommand() {
  const config = loadConfig();
  const runtimeState = readRuntimeState(config.runtimeFile);

  if (!runtimeState || runtimeState.pid <= 0 || !isProcessRunning(runtimeState.pid)) {
    if (runtimeState) {
      clearRuntimeArtifacts(runtimeState, config.runtimeFile);
    }
    process.stdout.write("rmtcdx is stopped.\n");
    return;
  }

  const lines = statusLines(runtimeState);
  process.stdout.write(`rmtcdx is running.\n${lines.join("\n")}\n`);
}

function printStartupSummary(runtimeState: RuntimeState, alreadyRunning: boolean) {
  const lines = statusLines(runtimeState);
  process.stdout.write(`${alreadyRunning ? "rmtcdx is already running." : "rmtcdx is running."}\n${lines.join("\n")}\n`);
}

function statusLines(runtimeState: RuntimeState) {
  const lines = [`Local: http://127.0.0.1:${runtimeState.port}`];
  const privateIpv4 = preferredPrivateIpv4();

  if (privateIpv4) {
    lines.push(`Phone on the same network: http://${privateIpv4}:${runtimeState.port}`);
  }

  if (runtimeState.tailscale.enabled && runtimeState.tailscale.url) {
    lines.push(`Phone outside your network: ${runtimeState.tailscale.url}`);
  } else {
    lines.push("If you want to connect to Codex from your phone outside your network, run `npx rmtcdx up --tailscale`.");
  }

  return lines;
}

function childCommandArgs() {
  const entryFile = fileURLToPath(import.meta.url);
  return entryFile.endsWith(".ts")
    ? ["--import", "tsx", entryFile, "serve"]
    : [entryFile, "serve"];
}

async function waitForServerReady(port: number, pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      throw new Error("rmtcdx exited before it became ready.");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the timeout expires.
    }

    await delay(POLL_INTERVAL_MS);
  }

  throw new Error("Timed out while waiting for rmtcdx to start.");
}

async function stopProcess(pid: number, timeoutMs: number) {
  if (!isProcessRunning(pid)) {
    return;
  }

  safeKill(pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return;
    }
    await delay(POLL_INTERVAL_MS);
  }

  safeKill(pid, "SIGKILL");
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error) || !("code" in error) || error.code !== "ESRCH";
  }
}

function safeKill(pid: number, signal: NodeJS.Signals = "SIGTERM") {
  try {
    process.kill(pid, signal);
  } catch {
    // Best effort cleanup.
  }
}

function clearRuntimeArtifacts(runtimeState: RuntimeState, runtimeFile: string) {
  clearRuntimeState(runtimeFile);

  if (runtimeState.tailscale.backupFile) {
    fs.rmSync(runtimeState.tailscale.backupFile, { force: true });
  }
}
