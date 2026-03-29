import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

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

export function readRepoConfigOptional(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return [] satisfies RepoConfig[];
  }

  return parseRepoConfig(filePath);
}
