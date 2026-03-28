import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Repository } from "../../../../packages/shared-types/src/index";
import type { RepoConfig } from "../config/repos";
import { Database } from "../db/database";

const execFileAsync = promisify(execFile);

export class RepositoryService {
  constructor(
    private readonly db: Database,
    private readonly repoConfig: RepoConfig[]
  ) {}

  sync() {
    this.db.syncRepositories(this.repoConfig);
  }

  async list() {
    const repos = this.db.listRepositoriesBase();
    return Promise.all(repos.map((repo) => this.withBranch(repo)));
  }

  async get(repoId: string) {
    const repo = this.db.getRepository(repoId);
    if (!repo) {
      return null;
    }

    return this.withBranch(repo);
  }

  private async withBranch(repo: Repository): Promise<Repository> {
    const branch = await this.readBranch(repo.path);
    return {
      ...repo,
      branch
    };
  }

  private async readBranch(repoPath: string) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", repoPath, "branch", "--show-current"]);
      const branch = stdout.trim();
      return branch || undefined;
    } catch {
      return undefined;
    }
  }
}
