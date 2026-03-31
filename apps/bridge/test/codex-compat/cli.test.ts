import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs } from "../../src/cli/args";
import { selectPreferredPrivateIpv4 } from "../../src/cli/network";

test("parseCliArgs defaults to up", () => {
  assert.deepEqual(parseCliArgs([]), { name: "up", tailscale: false });
});

test("parseCliArgs accepts up --tailscale", () => {
  assert.deepEqual(parseCliArgs(["up", "--tailscale"]), { name: "up", tailscale: true });
});

test("parseCliArgs rejects unknown options", () => {
  assert.throws(() => parseCliArgs(["up", "--nope"]), /Unknown option/);
});

test("selectPreferredPrivateIpv4 prefers 192.168 addresses", () => {
  assert.equal(
    selectPreferredPrivateIpv4(["10.0.0.8", "172.20.4.3", "192.168.1.67"]),
    "192.168.1.67"
  );
});
