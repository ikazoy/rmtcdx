import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appName = "remote-control-codex";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundledWebDistDir = path.join(packageRoot, "web-dist");
const workspaceRoot = resolveWorkspaceRoot();

export type AppConfig = {
  port: number;
  host: string;
  reposFile: string;
  dataDir: string;
  dbFile: string;
  codexDebugLogFile: string;
  uploadsDir: string;
  webDistDir: string;
  codexMode: "auto" | "real" | "mock";
  maxPromptLength: number;
  maxImageAttachments: number;
  maxImageAttachmentBytes: number;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidSubject?: string;
};

function resolveWorkspaceRoot() {
  const explicitRoot = process.env.WORKSPACE_ROOT;
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }

  const candidate = path.resolve(packageRoot, "../..");
  return isSourceCheckout(candidate) ? candidate : null;
}

function isSourceCheckout(root: string) {
  return (
    fs.existsSync(path.join(root, "package.json")) &&
    fs.existsSync(path.join(root, "apps/bridge/package.json")) &&
    fs.existsSync(path.join(root, "apps/web/package.json")) &&
    fs.existsSync(path.join(root, "repos.example.json"))
  );
}

function resolveUserConfigDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", appName);
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, appName);
  }

  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), appName);
}

function resolveUserDataDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", appName);
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, appName);
  }

  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), appName);
}

function resolveDefaultWebDistDir() {
  if (fs.existsSync(bundledWebDistDir)) {
    return bundledWebDistDir;
  }

  if (workspaceRoot) {
    return path.join(workspaceRoot, "apps/web/dist");
  }

  return bundledWebDistDir;
}

export function loadConfig(): AppConfig {
  const defaultConfigDir = resolveUserConfigDir();
  const dataDir = process.env.DATA_DIR ?? (workspaceRoot ? path.join(workspaceRoot, "data") : resolveUserDataDir());

  return {
    port: Number(process.env.PORT ?? 3210),
    host: process.env.HOST ?? "127.0.0.1",
    reposFile: process.env.REPO_CONFIG_PATH ?? (workspaceRoot ? path.join(workspaceRoot, "repos.json") : path.join(defaultConfigDir, "repos.json")),
    dataDir,
    dbFile: process.env.DB_FILE ?? path.join(dataDir, "remote-control.db"),
    codexDebugLogFile: process.env.CODEX_DEBUG_LOG_FILE ?? path.join(dataDir, "codex-app-server.jsonl"),
    uploadsDir: process.env.UPLOADS_DIR ?? path.join(dataDir, "uploads"),
    webDistDir: process.env.WEB_DIST_DIR ?? resolveDefaultWebDistDir(),
    codexMode: (process.env.CODEX_MODE as AppConfig["codexMode"] | undefined) ?? "auto",
    maxPromptLength: Number(process.env.MAX_PROMPT_LENGTH ?? 12000),
    maxImageAttachments: Number(process.env.MAX_IMAGE_ATTACHMENTS ?? 5),
    maxImageAttachmentBytes: Number(process.env.MAX_IMAGE_ATTACHMENT_BYTES ?? 10 * 1024 * 1024),
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
    vapidSubject: process.env.VAPID_SUBJECT
  };
}
