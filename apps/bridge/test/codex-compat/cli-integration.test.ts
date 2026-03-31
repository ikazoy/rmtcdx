import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("cli up/status/stop works in mock mode", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "rmtcdx-cli-integration-"));
  const dataDir = path.join(rootDir, "data");
  const repoConfigPath = path.join(rootDir, "repos.json");
  const port = await availablePort();
  const entryFile = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
  const workspaceRoot = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
  const env = {
    ...process.env,
    PORT: `${port}`,
    HOST: "127.0.0.1",
    CODEX_MODE: "mock",
    DATA_DIR: dataDir,
    REPO_CONFIG_PATH: repoConfigPath
  };
  const runCli = (args: string[]) =>
    execFileSync(process.execPath, ["--import", "tsx", entryFile, ...args], {
      cwd: workspaceRoot,
      env,
      encoding: "utf8"
    });

  t.after(() => {
    try {
      runCli(["stop"]);
    } catch {
      // Best-effort cleanup for detached child processes.
    }
  });

  const upOutput = runCli(["up"]);
  assert.match(upOutput, /rmtcdx is running\./);
  assert.match(upOutput, new RegExp(`Local: http://127\\.0\\.0\\.1:${port}`));
  assert.match(
    upOutput,
    /If you want to connect to Codex from your phone outside your network, run `npx rmtcdx up --tailscale`\./
  );

  const runtimeFile = path.join(dataDir, "runtime.json");
  await waitFor(async () => {
    try {
      await fs.access(runtimeFile);
      return true;
    } catch {
      return false;
    }
  });

  const runtimeState = JSON.parse(await fs.readFile(runtimeFile, "utf8")) as { pid: number; port: number };
  assert.equal(runtimeState.port, port);
  assert.equal(typeof runtimeState.pid, "number");
  assert.ok(runtimeState.pid > 0);

  const statusOutput = runCli(["status"]);
  assert.match(statusOutput, /rmtcdx is running\./);
  assert.match(statusOutput, new RegExp(`Local: http://127\\.0\\.0\\.1:${port}`));

  const healthResponse = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(healthResponse.ok, true);

  const stopOutput = runCli(["stop"]);
  assert.match(stopOutput, /rmtcdx has stopped\./);

  await waitFor(async () => !(await isPortListening(port)));

  const stoppedOutput = runCli(["status"]);
  assert.match(stoppedOutput, /rmtcdx is stopped\./);

  try {
    await fs.access(runtimeFile);
    assert.fail("runtime.json should be removed after stop");
  } catch {
    // Expected.
  }
});

function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate a TCP port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 8_000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Timed out waiting for the CLI integration assertion.");
}

function isPortListening(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}
