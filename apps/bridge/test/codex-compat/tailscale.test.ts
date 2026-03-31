import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  dnsNameFromTailscaleStatus,
  enableTailscaleServe,
  ensureTailscaleAvailable,
  restoreTailscaleServe,
  type TailscaleRunner,
  type TailscaleRunnerResult
} from "../../src/cli/tailscale";

test("ensureTailscaleAvailable reports missing tailscale", () => {
  const runner: TailscaleRunner = () => ({
    status: null,
    stdout: "",
    stderr: "",
    error: new Error("spawn tailscale ENOENT")
  });

  assert.throws(
    () => ensureTailscaleAvailable(runner),
    /Tailscale is not installed\./
  );
});

test("ensureTailscaleAvailable reports not-ready tailscale", () => {
  const runner: TailscaleRunner = () => ({
    status: 1,
    stdout: "",
    stderr: "logged out"
  });

  assert.throws(
    () => ensureTailscaleAvailable(runner),
    /Tailscale is installed but not ready\.\nlogged out/
  );
});

test("dnsNameFromTailscaleStatus trims the trailing dot", () => {
  assert.equal(
    dnsNameFromTailscaleStatus(JSON.stringify({ Self: { DNSName: "device.example.ts.net." } })),
    "device.example.ts.net"
  );
});

test("enableTailscaleServe writes a backup file and returns the published url", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "rmtcdx-tailscale-success-"));
  const calls: string[][] = [];
  const responses = new Map<string, TailscaleRunnerResult>([
    [
      'status --json',
      {
        status: 0,
        stdout: JSON.stringify({ Self: { DNSName: "device.example.ts.net." } }),
        stderr: ""
      }
    ],
    [
      'serve get-config --all',
      {
        status: 0,
        stdout: '{\n  "version": "0.0.1"\n}\n',
        stderr: ""
      }
    ],
    [
      'serve --bg --yes 3210',
      {
        status: 0,
        stdout: "",
        stderr: ""
      }
    ]
  ]);
  const runner: TailscaleRunner = (args) => {
    calls.push(args);
    return responses.get(args.join(" ")) ?? { status: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
  };

  const result = enableTailscaleServe({
    port: 3210,
    dataDir: rootDir,
    runner
  });

  assert.equal(result.url, "https://device.example.ts.net/");
  assert.equal(await fs.readFile(result.backupFile, "utf8"), '{\n  "version": "0.0.1"\n}\n');
  assert.deepEqual(calls, [
    ["status", "--json"],
    ["serve", "get-config", "--all"],
    ["serve", "--bg", "--yes", "3210"]
  ]);
});

test("enableTailscaleServe restores the previous config when publish fails", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "rmtcdx-tailscale-failure-"));
  const calls: string[][] = [];
  const runner: TailscaleRunner = (args) => {
    calls.push(args);
    const key = args.join(" ");

    if (key === "status --json") {
      return {
        status: 0,
        stdout: JSON.stringify({ Self: { DNSName: "device.example.ts.net." } }),
        stderr: ""
      };
    }

    if (key === "serve get-config --all") {
      return {
        status: 0,
        stdout: '{\n  "version": "0.0.1"\n}\n',
        stderr: ""
      };
    }

    if (key === "serve --bg --yes 3210") {
      return {
        status: 1,
        stdout: "",
        stderr: "serve failed"
      };
    }

    if (args[0] === "serve" && args[1] === "set-config" && args[2] === "--all") {
      return {
        status: 0,
        stdout: "",
        stderr: ""
      };
    }

    return {
      status: 1,
      stdout: "",
      stderr: `unexpected: ${key}`
    };
  };

  assert.throws(
    () =>
      enableTailscaleServe({
        port: 3210,
        dataDir: rootDir,
        runner
      }),
    /Unable to enable Tailscale Serve for rmtcdx\.\nserve failed/
  );

  assert.equal(
    calls.some((args) => args[0] === "serve" && args[1] === "set-config" && args[2] === "--all"),
    true
  );
});

test("restoreTailscaleServe is a no-op when the backup file is missing", () => {
  const calls: string[][] = [];
  const runner: TailscaleRunner = (args) => {
    calls.push(args);
    return { status: 0, stdout: "", stderr: "" };
  };

  restoreTailscaleServe("/tmp/does-not-exist/runtime.json", runner);
  assert.deepEqual(calls, []);
});
