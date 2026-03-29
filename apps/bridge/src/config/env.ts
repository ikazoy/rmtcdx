import path from "node:path";

const workspaceRoot = process.env.WORKSPACE_ROOT ?? path.resolve(process.cwd(), "../..");

export type AppConfig = {
  port: number;
  host: string;
  reposFile: string;
  dataDir: string;
  dbFile: string;
  uploadsDir: string;
  webDistDir: string;
  codexMode: "auto" | "real" | "mock";
  maxPromptLength: number;
  maxImageAttachments: number;
  maxImageAttachmentBytes: number;
};

export function loadConfig(): AppConfig {
  const dataDir = process.env.DATA_DIR ?? path.join(workspaceRoot, "data");

  return {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? "127.0.0.1",
    reposFile: process.env.REPO_CONFIG_PATH ?? path.join(workspaceRoot, "repos.json"),
    dataDir,
    dbFile: process.env.DB_FILE ?? path.join(dataDir, "remote-control.db"),
    uploadsDir: process.env.UPLOADS_DIR ?? path.join(dataDir, "uploads"),
    webDistDir: process.env.WEB_DIST_DIR ?? path.join(workspaceRoot, "apps/web/dist"),
    codexMode: (process.env.CODEX_MODE as AppConfig["codexMode"] | undefined) ?? "auto",
    maxPromptLength: Number(process.env.MAX_PROMPT_LENGTH ?? 12000),
    maxImageAttachments: Number(process.env.MAX_IMAGE_ATTACHMENTS ?? 5),
    maxImageAttachmentBytes: Number(process.env.MAX_IMAGE_ATTACHMENT_BYTES ?? 10 * 1024 * 1024)
  };
}
