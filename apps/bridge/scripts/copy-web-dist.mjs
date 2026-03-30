import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const sourceDir = path.resolve(packageRoot, "../web/dist");
const targetDir = path.join(packageRoot, "web-dist");

if (!fs.existsSync(sourceDir)) {
  throw new Error(
    `Built web assets not found at ${sourceDir}. Run "npm run build -w @codex-remote/web" first.`
  );
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.cpSync(sourceDir, targetDir, { recursive: true });
