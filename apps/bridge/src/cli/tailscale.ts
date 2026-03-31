import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type TailscaleRunnerResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type TailscaleRunner = (args: string[]) => TailscaleRunnerResult;

type TailscaleStatusResponse = {
  Self?: {
    DNSName?: string;
  };
};

export function defaultTailscaleRunner(args: string[]): TailscaleRunnerResult {
  const result = spawnSync("tailscale", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? undefined
  };
}

export function ensureTailscaleAvailable(runner: TailscaleRunner = defaultTailscaleRunner) {
  const result = runner(["status", "--json"]);

  if (result.error) {
    throw new Error(
      result.error.message.includes("ENOENT")
        ? "Tailscale is not installed.\nFor external access, install Tailscale and run `npx rmtcdx up --tailscale`."
        : `Unable to run Tailscale.\n${result.error.message}`
    );
  }

  if (result.status !== 0) {
    const message = normalizeTailscaleMessage(result.stderr || result.stdout);
    throw new Error(message ? `Tailscale is installed but not ready.\n${message}` : "Tailscale is installed but not ready.");
  }

  const dnsName = dnsNameFromTailscaleStatus(result.stdout);
  if (!dnsName) {
    throw new Error("Tailscale is installed but did not report a device DNS name.");
  }

  return {
    dnsName,
    url: `https://${dnsName}/`
  };
}

export function enableTailscaleServe(params: {
  port: number;
  dataDir: string;
  runner?: TailscaleRunner;
}) {
  const runner = params.runner ?? defaultTailscaleRunner;
  const status = ensureTailscaleAvailable(runner);
  const backupFile = path.join(params.dataDir, "tailscale-serve-backup.json");

  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  const currentConfig = runAndCapture(runner, ["serve", "get-config", "--all"], "Unable to back up the current Tailscale Serve config.");
  fs.writeFileSync(backupFile, `${currentConfig.trim() || '{\n  "version": "0.0.1"\n}'}\n`, "utf8");

  try {
    runOrThrow(runner, ["serve", "--bg", "--yes", `${params.port}`], "Unable to enable Tailscale Serve for rmtcdx.");
  } catch (error) {
    try {
      restoreTailscaleServe(backupFile, runner);
    } catch {
      // Keep the original failure as the primary error.
    }
    throw error;
  }

  return {
    backupFile,
    url: status.url
  };
}

export function restoreTailscaleServe(backupFile: string, runner: TailscaleRunner = defaultTailscaleRunner) {
  if (!fs.existsSync(backupFile)) {
    return;
  }

  runOrThrow(runner, ["serve", "set-config", "--all", backupFile], "Unable to restore the previous Tailscale Serve config.");
}

export function dnsNameFromTailscaleStatus(raw: string) {
  const parsed = JSON.parse(raw) as TailscaleStatusResponse;
  const dnsName = parsed.Self?.DNSName?.trim();
  return dnsName ? dnsName.replace(/\.$/, "") : null;
}

function runOrThrow(runner: TailscaleRunner, args: string[], prefix: string) {
  runAndCapture(runner, args, prefix);
}

function runAndCapture(runner: TailscaleRunner, args: string[], prefix: string) {
  const result = runner(args);

  if (result.error) {
    throw new Error(`${prefix}\n${result.error.message}`);
  }

  if (result.status !== 0) {
    const message = normalizeTailscaleMessage(result.stderr || result.stdout);
    throw new Error(message ? `${prefix}\n${message}` : prefix);
  }

  return result.stdout;
}

function normalizeTailscaleMessage(message: string) {
  return message
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}
