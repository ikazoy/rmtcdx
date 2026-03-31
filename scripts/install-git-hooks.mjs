import { execFileSync } from "node:child_process";

if (process.env.CI === "true") {
  process.exit(0);
}

if (!isInsideGitWorkTree()) {
  process.exit(0);
}

execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"], {
  cwd: process.cwd(),
  stdio: "ignore"
});

function isInsideGitWorkTree() {
  try {
    const output = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return output === "true";
  } catch {
    return false;
  }
}
