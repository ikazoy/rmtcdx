import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appName = "rmtcdx";

type RuntimePaths = {
  packageRoot: string | null;
  bundledWebDistDir: string | null;
  workspaceRoot: string | null;
};

export type AppConfig = {
  port: number;
  host: string;
  reposFile: string;
  dataDir: string;
  stateFile: string;
  runtimeFile: string;
  codexDebugLogFile: string;
  uploadsDir: string;
  webDistDir: string;
  codexMode: "auto" | "real" | "mock";
  maxPromptLength: number;
  maxImageAttachments: number;
  maxImageAttachmentBytes: number;
  devSimulatorEnabled: boolean;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidSubject?: string;
};

function resolveRuntimePaths(): RuntimePaths {
  const currentModuleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolvePackageRoot(currentModuleDir);
  const workspaceRoot = resolveWorkspaceRoot(currentModuleDir);

  return {
    packageRoot,
    bundledWebDistDir: packageRoot ? path.join(packageRoot, "web-dist") : null,
    workspaceRoot
  };
}

function resolveWorkspaceRoot(currentModuleDir: string) {
  const explicitRoot = process.env.WORKSPACE_ROOT;
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }

  return findAncestorDirectory(currentModuleDir, isSourceCheckout);
}

function isSourceCheckout(root: string) {
  return (
    fs.existsSync(path.join(root, "package.json")) &&
    fs.existsSync(path.join(root, "apps/bridge/package.json")) &&
    fs.existsSync(path.join(root, "apps/web/package.json")) &&
    fs.existsSync(path.join(root, "repos.example.json"))
  );
}

function resolvePackageRoot(currentModuleDir: string) {
  return findAncestorDirectory(currentModuleDir, isBridgePackageRoot);
}

function isBridgePackageRoot(root: string) {
  const packageJsonPath = path.join(root, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: string };
    return packageJson.name === "rmtcdx";
  } catch {
    return false;
  }
}

function findAncestorDirectory(startDir: string, predicate: (dir: string) => boolean) {
  let currentDir = startDir;

  while (true) {
    if (predicate(currentDir)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
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

function resolveDefaultWebDistDir(runtimePaths: RuntimePaths) {
  if (runtimePaths.bundledWebDistDir && fs.existsSync(runtimePaths.bundledWebDistDir)) {
    return runtimePaths.bundledWebDistDir;
  }

  if (runtimePaths.workspaceRoot) {
    return path.join(runtimePaths.workspaceRoot, "apps/web/dist");
  }

  if (runtimePaths.bundledWebDistDir) {
    return runtimePaths.bundledWebDistDir;
  }

  throw new Error("Unable to resolve web-dist directory. Set WEB_DIST_DIR explicitly.");
}

function resolveStateFile(dataDir: string) {
  if (process.env.STATE_FILE) {
    return process.env.STATE_FILE;
  }

  if (!process.env.DB_FILE) {
    return path.join(dataDir, "state.json");
  }

  return process.env.DB_FILE.endsWith(".db")
    ? process.env.DB_FILE.replace(/\.db$/i, ".json")
    : `${process.env.DB_FILE}.json`;
}

function resolveRuntimeFile(dataDir: string) {
  return process.env.RUNTIME_FILE ?? path.join(dataDir, "runtime.json");
}

export function loadConfig(): AppConfig {
  const runtimePaths = resolveRuntimePaths();
  const defaultConfigDir = resolveUserConfigDir();
  const dataDir = process.env.DATA_DIR ?? (runtimePaths.workspaceRoot ? path.join(runtimePaths.workspaceRoot, "data") : resolveUserDataDir());

  return {
    port: Number(process.env.PORT ?? 3210),
    host: process.env.HOST ?? "127.0.0.1",
    reposFile:
      process.env.REPO_CONFIG_PATH ??
      (runtimePaths.workspaceRoot ? path.join(runtimePaths.workspaceRoot, "repos.json") : path.join(defaultConfigDir, "repos.json")),
    dataDir,
    stateFile: resolveStateFile(dataDir),
    runtimeFile: resolveRuntimeFile(dataDir),
    codexDebugLogFile: process.env.CODEX_DEBUG_LOG_FILE ?? path.join(dataDir, "codex-app-server.jsonl"),
    uploadsDir: process.env.UPLOADS_DIR ?? path.join(dataDir, "uploads"),
    webDistDir: process.env.WEB_DIST_DIR ?? resolveDefaultWebDistDir(runtimePaths),
    codexMode: (process.env.CODEX_MODE as AppConfig["codexMode"] | undefined) ?? "auto",
    maxPromptLength: Number(process.env.MAX_PROMPT_LENGTH ?? 12000),
    maxImageAttachments: Number(process.env.MAX_IMAGE_ATTACHMENTS ?? 5),
    maxImageAttachmentBytes: Number(process.env.MAX_IMAGE_ATTACHMENT_BYTES ?? 10 * 1024 * 1024),
    devSimulatorEnabled: process.env.CODEX_ENABLE_DEV_TOOLS === "1",
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
    vapidSubject: process.env.VAPID_SUBJECT
  };
}
