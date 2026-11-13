import { AuthError } from "./errors.js";
import { verifyAccessToken } from "./tokens.js";

export function createAuthenticationMiddleware({
  prisma,
  accessTokenSecret,
  now = () => new Date(),
}) {
  return async function authenticate(c, next) {
    const authorization = c.req.header("authorization");
    const match = authorization?.match(/^Bearer ([^\s]+)$/i);
    if (!match) {
      throw new AuthError("UNAUTHORIZED", 401, "Autentikasi diperlukan.");
    }

    const claims = verifyAccessToken(match[1], {
      secret: accessTokenSecret,
      now: now(),
    });

    const session = await prisma.authSession.findUnique({
      where: { id: claims.sessionId },
      include: {
        user: {
          select: { id: true, isActive: true },
        },
      },
    });

    if (
      !session ||
      session.userId !== claims.userId ||
      !session.user ||
      session.revokedAt ||
      session.expiresAt <= now()
    ) {
      throw new AuthError("SESSION_REVOKED", 401, "Sesi sudah tidak berlaku.");
    }

    if (!session.user.isActive) {
      throw new AuthError(
        "ACCOUNT_DISABLED",
        403,
        "Akun tidak aktif. Hubungi administrator.",
      );
    }

    c.set("auth", {
      userId: session.userId,
      sessionId: session.id,
    });
    await next();
  };
}
