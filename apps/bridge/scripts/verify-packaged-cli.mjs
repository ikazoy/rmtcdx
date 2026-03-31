import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

const workspaceRoot = process.cwd();
const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "rmtcdx-packaged-cli-"));
const dataDir = path.join(rootDir, "data");
const repoConfigPath = path.join(rootDir, "repos.json");
const npmCacheDir = path.join(rootDir, "npm-cache");
const port = await availablePort();

let tarballPath = null;

try {
  tarballPath = await packWorkspacePackage();

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(npmCacheDir, { recursive: true });
  await fs.writeFile(
    repoConfigPath,
    `${JSON.stringify([{ id: "smoke_repo", name: "Smoke Repo", path: workspaceRoot, pinned: true }], null, 2)}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    PORT: `${port}`,
    HOST: "127.0.0.1",
    CODEX_MODE: "mock",
    DATA_DIR: dataDir,
    REPO_CONFIG_PATH: repoConfigPath,
    npm_config_cache: npmCacheDir
  };

  const upOutput = await runCli(["up"], env);
  assert.match(upOutput, /rmtcdx is running\./);

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    return response.ok;
  });

  const reposResponse = await fetch(`http://127.0.0.1:${port}/api/repos`);
  assert.equal(reposResponse.ok, true);
  const reposPayload = await reposResponse.json();
  assert.ok(Array.isArray(reposPayload.repos));
  assert.ok(reposPayload.repos.length > 0);

  const statusOutput = await runCli(["status"], env);
  assert.match(statusOutput, /rmtcdx is running\./);
  assert.match(statusOutput, new RegExp(`Local: http://127\\.0\\.0\\.1:${port}`));

  process.stdout.write(`Packaged CLI smoke test passed on http://127.0.0.1:${port}.\n`);

  await runCli(["stop"], env);
} finally {
  await bestEffortStop(tarballPath, {
    ...process.env,
    PORT: `${port}`,
    HOST: "127.0.0.1",
    CODEX_MODE: "mock",
    DATA_DIR: dataDir,
    REPO_CONFIG_PATH: repoConfigPath,
    npm_config_cache: npmCacheDir
  });
  await fs.rm(rootDir, { recursive: true, force: true });
  if (tarballPath) {
    await fs.rm(tarballPath, { force: true });
  }
}

async function packWorkspacePackage() {
  const manifest = JSON.parse(
    await fs.readFile(path.join(workspaceRoot, "apps/bridge/package.json"), "utf8")
  );
  const filename = `${String(manifest.name).replace(/^@/, "").replace(/\//g, "-")}-${manifest.version}.tgz`;
  const tarballPath = path.resolve(workspaceRoot, filename);

  await fs.rm(tarballPath, { force: true });
  await execFileAsync(
    npmCommand,
    ["pack", "-w", "rmtcdx"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16
    }
  );
  await fs.access(tarballPath);

  return tarballPath;
}

async function runCli(args, env) {
  const { stdout } = await execFileAsync(
    npxCommand,
    ["--yes", "--package", tarballPath, "rmtcdx", ...args],
    {
      cwd: workspaceRoot,
      env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16
    }
  );

  return stdout;
}

async function bestEffortStop(currentTarballPath, env) {
  if (!currentTarballPath) {
    return;
  }

  try {
    await execFileAsync(
      npxCommand,
      ["--yes", "--package", currentTarballPath, "rmtcdx", "stop"],
      {
        cwd: workspaceRoot,
        env,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 16
      }
    );
  } catch {
    // Best-effort cleanup for detached child processes.
  }
}

async function waitFor(check, timeoutMs = 20_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (await check()) {
        return;
      }
    } catch {
      // Keep retrying until the server is ready.
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Timed out waiting for the packaged CLI smoke test.");
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate a TCP port."));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}
