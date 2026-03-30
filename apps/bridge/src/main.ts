#!/usr/bin/env node

import { buildApp } from "./app";

const { app, config } = await buildApp();

try {
  await app.listen({
    port: config.port,
    host: config.host
  });
  app.log.info(`Bridge listening on http://${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
