import { execFileSync } from "node:child_process";

const releaseRelevantMatchers = [
  /^apps\/bridge\/src\//,
  /^apps\/bridge\/package\.json$/,
  /^apps\/web\/src\//,
  /^apps\/web\/public\//,
  /^apps\/web\/index\.html$/,
  /^apps\/web\/package\.json$/,
  /^packages\/shared-types\/src\//,
  /^packages\/shared-types\/package\.json$/
];

const baseSha = process.env.GITHUB_BASE_SHA?.trim();
const range = baseSha ? `${baseSha}...HEAD` : `${resolveMergeBase("origin/main")}...HEAD`;
const changedFiles = git(["diff", "--name-only", "--diff-filter=ACMR", range]);

if (changedFiles.length === 0) {
  process.stdout.write("No changed files found in the current diff.\n");
  process.exit(0);
}

const changedChangesetFiles = changedFiles.filter((file) => file.startsWith(".changeset/") && file !== ".changeset/README.md");
const releaseRelevantFiles = changedFiles.filter((file) => releaseRelevantMatchers.some((matcher) => matcher.test(file)));

if (releaseRelevantFiles.length === 0) {
  process.stdout.write("No release-relevant files changed; no changeset is required.\n");
  process.exit(0);
}

if (changedChangesetFiles.length > 0) {
  process.stdout.write("Changeset found for release-relevant changes.\n");
  process.exit(0);
}

process.stderr.write("Release-relevant files changed without a matching changeset.\n");
process.stderr.write("Add a changeset with `npm run changeset`, or keep the change docs/tests/config-only.\n");
process.stderr.write(`Compared range: ${range}\n`);
process.stderr.write(`Changed files:\n${formatList(releaseRelevantFiles)}\n`);
process.exit(1);

function resolveMergeBase(baseRef) {
  const mergeBase = git(["merge-base", baseRef, "HEAD"]);
  if (mergeBase.length === 0 || !mergeBase[0]) {
    throw new Error(`Unable to determine merge base against ${baseRef}.`);
  }

  return mergeBase[0];
}

function git(args) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8"
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatList(files) {
  return files.map((file) => `- ${file}`).join("\n");
}
