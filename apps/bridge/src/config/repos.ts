import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";
import { createIsolatedGitEnv } from "../utils/git-env";

const repoConfigSchema = z.array(
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    path: z.string().min(1),
    description: z.string().optional(),
    pinned: z.boolean().default(false)
  })
);

export type RepoConfig = z.infer<typeof repoConfigSchema>[number];

function parseRepoConfig(filePath: string) {
  const raw = fs.readFileSync(filePath, "utf8");
  const configDir = path.dirname(filePath);
  return repoConfigSchema.parse(JSON.parse(raw)).map((repo) => {
    const resolvedPath = path.isAbsolute(repo.path)
      ? repo.path
      : path.resolve(configDir, repo.path);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(
        `Configured repository path does not exist: ${resolvedPath} (repo id: ${repo.id})`
      );
    }

    return {
      ...repo,
      path: resolvedPath
    };
  });
}

function inferRepoConfigFromCwd(cwd: string) {
  try {
    const rootPath = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: createIsolatedGitEnv()
    }).trim();

    if (!rootPath || !fs.existsSync(rootPath)) {
      return [] satisfies RepoConfig[];
    }

    return [
      {
        id: `repo_${createHash("sha1").update(rootPath).digest("hex").slice(0, 12)}`,
        name: path.basename(rootPath),
        path: rootPath,
        description: "Implicit repository from the current working directory",
        pinned: true
      }
    ] satisfies RepoConfig[];
  } catch {
    return [] satisfies RepoConfig[];
  }
}

export function readRepoConfig(filePath: string) {
  if (!fs.existsSync(filePath)) {
    const examplePath = path.join(path.dirname(filePath), "repos.example.json");
    const hint = fs.existsSync(examplePath)
      ? ` Copy repos.example.json to ${path.basename(filePath)} and update the repo paths first.`
      : "";
    throw new Error(`Repository config not found: ${filePath}.${hint}`);
  }

  return parseRepoConfig(filePath);
}

export function readRepoConfigOptional(filePath: string, options?: { fallbackCwd?: string }) {
  if (!fs.existsSync(filePath)) {
    return inferRepoConfigFromCwd(options?.fallbackCwd ?? process.cwd());
  }

  return parseRepoConfig(filePath);
}
