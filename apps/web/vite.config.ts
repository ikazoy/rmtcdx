import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const DEFAULT_WEB_PORT = 4173;

function resolveWebPort() {
  const rawPort = process.env.WEB_PORT;

  if (!rawPort) {
    return DEFAULT_WEB_PORT;
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`WEB_PORT must be an integer between 1 and 65535. Received: ${rawPort}`);
  }

  return port;
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: resolveWebPort(),
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/healthz": "http://127.0.0.1:3000",
      "/ws": {
        target: "ws://127.0.0.1:3000",
        ws: true
      }
    }
  }
});
