import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearRuntimeState,
  readRuntimeState,
  writeRuntimeState,
  type RuntimeState
} from "../../src/cli/runtime-state";

test("runtime-state roundtrip writes, reads, and clears state", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "rmtcdx-runtime-state-"));
  const filePath = path.join(rootDir, "runtime.json");
  const state: RuntimeState = {
    pid: 12345,
    port: 3210,
    host: "0.0.0.0",
    startedAt: "2026-03-31T00:00:00.000Z",
    tailscale: {
      enabled: true,
      url: "https://example.ts.net/",
      backupFile: path.join(rootDir, "tailscale-backup.json")
    }
  };

  writeRuntimeState(filePath, state);
  assert.deepEqual(readRuntimeState(filePath), state);

  clearRuntimeState(filePath);
  assert.equal(readRuntimeState(filePath), null);
});

test("runtime-state returns null for invalid json", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "rmtcdx-runtime-state-invalid-"));
  const filePath = path.join(rootDir, "runtime.json");

  await fs.writeFile(filePath, "{not-json}\n", "utf8");
  assert.equal(readRuntimeState(filePath), null);
});
