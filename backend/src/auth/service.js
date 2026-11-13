import { randomBytes } from "node:crypto";
import { AuthError, invalidCredentials } from "./errors.js";
import { hashPassword, verifyPassword } from "./password.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  createAccessToken,
  createRefreshToken,
  hashRefreshToken,
} from "./tokens.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const userProfileSelect = {
  id: true,
  name: true,
  email: true,
  isActive: true,
  memberships: {
    where: { outlet: { isActive: true } },
    select: {
      outletId: true,
      role: true,
      outlet: {
        select: {
          code: true,
          name: true,
        },
      },
    },
  },
};

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    memberships: user.memberships.map((membership) => ({
      outletId: membership.outletId,
      outletCode: membership.outlet.code,
      outletName: membership.outlet.name,
      role: membership.role,
    })),
  };
}

function sessionDto(session) {
  const expiresAt = session.expiresAt.toISOString();
  return {
    id: session.id,
    expiresAt,
  };
}

async function revokeSession(tx, sessionId, now) {
  await tx.authSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: now },
  });
  await tx.refreshToken.updateMany({
    where: { sessionId, revokedAt: null },
    data: { revokedAt: now },
  });
}

export function createAuthService({
  prisma,
  accessTokenSecret,
  verifyPasswordFn = verifyPassword,
  hashPasswordFn = hashPassword,
  now = () => new Date(),
}) {
  let dummyPasswordHash;

  async function verifyCredentials(user, password) {
    if (!user) {
      dummyPasswordHash ??= hashPasswordFn(randomBytes(32).toString("hex"));
      await verifyPasswordFn(password, await dummyPasswordHash);
      throw invalidCredentials();
    }

    if (!(await verifyPasswordFn(password, user.passwordHash))) {
      throw invalidCredentials();
    }
  }

  function accessTokenFor(userId, sessionId, issuedAt) {
    return createAccessToken({
      userId,
      sessionId,
      secret: accessTokenSecret,
      now: issuedAt,
    });
  }

  async function createSession(user, deviceName) {
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + SESSION_TTL_MS);
    const refreshToken = createRefreshToken();
    const session = await prisma.$transaction(async (tx) => {
      const created = await tx.authSession.create({
        data: {
          userId: user.id,
          deviceName: deviceName ?? null,
          expiresAt,
        },
      });

      await tx.refreshToken.create({
        data: {
          sessionId: created.id,
          tokenHash: hashRefreshToken(refreshToken),
        },
      });

      return created;
    });

    return {
      accessToken: accessTokenFor(user.id, session.id, issuedAt),
      tokenType: "Bearer",
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      refreshExpiresAt: expiresAt.toISOString(),
      session: sessionDto(session),
    };
  }

  async function login({ email, password, deviceName }) {
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        ...userProfileSelect,
        passwordHash: true,
      },
    });

    await verifyCredentials(user, password);

    if (!user.isActive) {
      throw new AuthError(
        "ACCOUNT_DISABLED",
        403,
        "Akun tidak aktif. Hubungi administrator.",
      );
    }

    const tokens = await createSession(user, deviceName);
    return {
      ...tokens,
      user: publicUser(user),
    };
  }

  async function refresh({ refreshToken }) {
    const tokenHash = hashRefreshToken(refreshToken);
    const replacementToken = createRefreshToken();
    const refreshedAt = now();

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.refreshToken.findUnique({
        where: { tokenHash },
        include: {
          session: {
            include: {
              user: {
                select: { id: true, isActive: true },
              },
            },
          },
        },
      });

      if (!current) {
        return { error: "INVALID_REFRESH_TOKEN" };
      }

      const session = current.session;
      if (current.usedAt) {
        await revokeSession(tx, session.id, refreshedAt);
        return { error: "REFRESH_TOKEN_REUSE_DETECTED" };
      }

      if (current.revokedAt || session.revokedAt) {
        return { error: "SESSION_REVOKED" };
      }

      if (session.expiresAt <= refreshedAt) {
        await revokeSession(tx, session.id, refreshedAt);
        return { error: "INVALID_REFRESH_TOKEN" };
      }

      if (!session.user.isActive) {
        await revokeSession(tx, session.id, refreshedAt);
        return { error: "ACCOUNT_DISABLED" };
      }

      const consumed = await tx.refreshToken.updateMany({
        where: {
          id: current.id,
          usedAt: null,
          revokedAt: null,
        },
        data: { usedAt: refreshedAt },
      });

      if (consumed.count !== 1) {
        await revokeSession(tx, session.id, refreshedAt);
        return { error: "REFRESH_TOKEN_REUSE_DETECTED" };
      }

      await tx.refreshToken.create({
        data: {
          sessionId: session.id,
          tokenHash: hashRefreshToken(replacementToken),
        },
      });

      return {
        accessToken: accessTokenFor(session.userId, session.id, refreshedAt),
        tokenType: "Bearer",
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshToken: replacementToken,
        refreshExpiresAt: session.expiresAt.toISOString(),
        session: sessionDto(session),
      };
    });

    if (result.error) {
      const errorMessages = {
        INVALID_REFRESH_TOKEN: [401, "Refresh token tidak valid."],
        REFRESH_TOKEN_REUSE_DETECTED: [
          401,
          "Refresh token digunakan kembali. Silakan login ulang.",
        ],
        SESSION_REVOKED: [401, "Sesi sudah dicabut. Silakan login ulang."],
        ACCOUNT_DISABLED: [
          403,
          "Akun tidak aktif. Hubungi administrator.",
        ],
      };
      const [status, message] = errorMessages[result.error];
      throw new AuthError(result.error, status, message);
    }

    return result;
  }

  async function getCurrentUser(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: userProfileSelect,
    });

    if (!user || !user.isActive) {
      throw new AuthError(
        "ACCOUNT_DISABLED",
        403,
        "Akun tidak aktif. Hubungi administrator.",
      );
    }

    return publicUser(user);
  }

  async function logout({ refreshToken }) {
    const token = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(refreshToken) },
      select: { sessionId: true },
    });

    if (token) {
      await prisma.$transaction(async (tx) => {
        await revokeSession(tx, token.sessionId, now());
      });
    }

    return { loggedOut: true };
  }

  async function logoutAll(userId) {
    const revokedAt = now();
    return prisma.$transaction(async (tx) => {
      const sessions = await tx.authSession.findMany({
        where: { userId },
        select: { id: true },
      });
      const sessionIds = sessions.map((session) => session.id);
      const revoked = await tx.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt },
      });

      if (sessionIds.length > 0) {
        await tx.refreshToken.updateMany({
          where: { sessionId: { in: sessionIds }, revokedAt: null },
          data: { revokedAt },
        });
      }

      return {
        loggedOut: true,
        revokedSessions: revoked.count,
      };
    });
  }

  return { login, refresh, getCurrentUser, logout, logoutAll };
}
