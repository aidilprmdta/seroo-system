
import "dotenv/config";

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { parseEnv } from "./config/env.js";
import prisma from "./lib/prisma.js";

const env = parseEnv(process.env);
const app = createApp({
  prisma,
  authConfig: {
    accessTokenSecret: env.JWT_ACCESS_SECRET,
  },
});

const server = serve({
  fetch: app.fetch,
  port: env.PORT,
});

console.info(`Seroo API listening on port ${env.PORT}`);

let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.info(`Received ${signal}; shutting down.`);

  server.close(async (error) => {
    if (error) {
      console.error(
        "HTTP server shutdown failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      process.exitCode = 1;
    }

    try {
      await prisma.$disconnect();
    } catch (disconnectError) {
      console.error(
        "Prisma client shutdown failed",
        disconnectError instanceof Error ? disconnectError.name : "UnknownError",
      );
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
