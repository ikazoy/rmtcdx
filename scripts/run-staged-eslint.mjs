import { execFileSync, spawnSync } from "node:child_process";

const stagedFiles = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
  .filter((file) => /^apps\/|^packages\//.test(file))
  .filter((file) => /\.(ts|tsx|mjs)$/.test(file));

if (stagedFiles.length === 0) {
  process.stdout.write("No staged TypeScript or .mjs files to lint.\n");
  process.exit(0);
}

const result = spawnSync("npx", ["eslint", "--max-warnings=0", ...stagedFiles], {
  cwd: process.cwd(),
  stdio: "inherit",
  shell: process.platform === "win32"
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);

function git(args) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8"
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
