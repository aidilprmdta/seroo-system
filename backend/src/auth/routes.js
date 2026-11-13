import { createHash } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { AuthError } from "./errors.js";
import { createAuthenticationMiddleware } from "./middleware.js";
import { createAuthService } from "./service.js";

const loginSchema = z
  .object({
    email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
    password: z.string().min(1).max(1024),
    deviceName: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

const refreshSchema = z
  .object({
    refreshToken: z.string().min(20).max(256),
  })
  .strict();

const logoutSchema = refreshSchema;

function parseBody(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AuthError(
      "VALIDATION_ERROR",
      400,
      "Periksa kembali data yang dikirim.",
    );
  }
  return result.data;
}

async function readJson(c) {
  try {
    return await c.req.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AuthError(
        "VALIDATION_ERROR",
        400,
        "Periksa kembali data yang dikirim.",
      );
    }
    throw error;
  }
}

function createRateLimiter({ limit, windowMs, maxEntries = 5000, now }) {
  const attempts = new Map();

  return {
    allow(key) {
      const timestamp = now();
      for (const [storedKey, entry] of attempts) {
        if (entry.resetAt <= timestamp) {
          attempts.delete(storedKey);
        }
      }

      let entry = attempts.get(key);
      if (!entry || entry.resetAt <= timestamp) {
        if (attempts.size >= maxEntries) {
          return false;
        }
        entry = { count: 0, resetAt: timestamp + windowMs };
        attempts.set(key, entry);
      }

      entry.count += 1;
      return entry.count <= limit;
    },
  };
}

function rateLimitKey(prefix, value) {
  return `${prefix}:${createHash("sha256").update(value).digest("hex")}`;
}

export function createAuthRoutes({
  prisma,
  authConfig,
  verifyPasswordFn,
  hashPasswordFn,
  now = () => new Date(),
  loginRateLimit = { limit: 5, windowMs: 15 * 60 * 1000 },
}) {
  const routes = new Hono();
  const service = createAuthService({
    prisma,
    accessTokenSecret: authConfig.accessTokenSecret,
    verifyPasswordFn,
    hashPasswordFn,
    now,
  });
  const loginLimiter = createRateLimiter({
    ...loginRateLimit,
    now: () => now().getTime(),
  });
  const refreshLimiter = createRateLimiter({
    limit: 20,
    windowMs: 15 * 60 * 1000,
    now: () => now().getTime(),
  });
  const authenticate = createAuthenticationMiddleware({
    prisma,
    accessTokenSecret: authConfig.accessTokenSecret,
    now,
  });

  routes.post("/login", async (c) => {
    const body = parseBody(loginSchema, await readJson(c));
    if (!loginLimiter.allow(rateLimitKey("login", body.email))) {
      throw new AuthError(
        "RATE_LIMITED",
        429,
        "Terlalu banyak percobaan. Coba lagi beberapa saat.",
      );
    }

    const data = await service.login(body);
    return c.json({ success: true, data }, 200);
  });

  routes.post("/refresh", async (c) => {
    const body = parseBody(refreshSchema, await readJson(c));
    if (!refreshLimiter.allow(rateLimitKey("refresh", body.refreshToken))) {
      throw new AuthError(
        "RATE_LIMITED",
        429,
        "Terlalu banyak permintaan. Coba lagi beberapa saat.",
      );
    }

    const data = await service.refresh(body);
    return c.json({ success: true, data }, 200);
  });

  routes.get("/me", authenticate, async (c) => {
    const auth = c.get("auth");
    const user = await service.getCurrentUser(auth.userId);
    const session = await prisma.authSession.findUnique({
      where: { id: auth.sessionId },
      select: { id: true, expiresAt: true },
    });

    if (!session) {
      throw new AuthError("SESSION_REVOKED", 401, "Sesi sudah tidak berlaku.");
    }

    return c.json({
      success: true,
      data: {
        user,
        session: {
          id: session.id,
          expiresAt: session.expiresAt.toISOString(),
        },
      },
    });
  });

  routes.post("/logout", async (c) => {
    const body = parseBody(logoutSchema, await readJson(c));
    const data = await service.logout(body);
    return c.json({ success: true, data }, 200);
  });

  routes.post("/logout-all", authenticate, async (c) => {
    const auth = c.get("auth");
    const data = await service.logoutAll(auth.userId);
    return c.json({ success: true, data }, 200);
  });

  return routes;
}
