import { Hono } from "hono";
import { createAuthRoutes } from "./auth/routes.js";
import { AuthError } from "./auth/errors.js";
import { PosError } from "./pos/errors.js";
import { createPosRoutes } from "./pos/routes.js";

export function createApp({
  prisma,
  logger = console,
  authConfig,
  authOptions = {},
  posOptions = {},
}) {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      success: true,
      data: { status: "ok" },
    }),
  );

  app.get("/health/ready", async (c) => {
    try {
      await prisma.$queryRaw`SELECT 1`;

      return c.json({
        success: true,
        data: { status: "ready" },
      });
    } catch (error) {
      logger.error(
        "Database readiness check failed",
        error instanceof Error ? error.name : "UnknownError",
      );

      return c.json(
        {
          success: false,
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Service is not ready",
          },
        },
        503,
      );
    }
  });

  if (authConfig) {
    app.route(
      "/api/v1/auth",
      createAuthRoutes({ prisma, authConfig, ...authOptions }),
    );
    app.route(
      "/api/v1/outlets",
      createPosRoutes({
        prisma,
        accessTokenSecret: authConfig.accessTokenSecret,
        ...posOptions,
      }),
    );
  }

  app.notFound((c) =>
    c.json(
      {
        success: false,
        error: {
          code: "NOT_FOUND",
          message: "Endpoint tidak ditemukan.",
        },
      },
      404,
    ),
  );

  app.onError((error, c) => {
    if (error instanceof AuthError || error instanceof PosError) {
      return c.json(
        {
          success: false,
          error: {
            code: error.code,
            message: error.message,
          },
        },
        error.status,
      );
    }

    logger.error(
      "Request failed",
      error instanceof Error ? error.name : "UnknownError",
    );

    return c.json(
      {
        success: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Terjadi kesalahan pada server.",
        },
      },
      500,
    );
  });

  return app;
}
