import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { AuthError } from "./errors.js";

export const ACCESS_TOKEN_TTL_SECONDS = 900;
const TOKEN_ISSUER = "seroo-api";
const TOKEN_AUDIENCE = "seroo-mobile";

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signatureFor(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function createAccessToken({ userId, sessionId, secret, now }) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const payload = encodeJson({
    sub: userId,
    sid: sessionId,
    iss: TOKEN_ISSUER,
    aud: TOKEN_AUDIENCE,
    iat: issuedAt,
    exp: issuedAt + ACCESS_TOKEN_TTL_SECONDS,
  });
  const unsignedToken = `${header}.${payload}`;

  return `${unsignedToken}.${signatureFor(unsignedToken, secret)}`;
}

export function verifyAccessToken(token, { secret, now }) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AuthError("UNAUTHORIZED", 401, "Sesi tidak valid.");
  }

  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new AuthError("UNAUTHORIZED", 401, "Sesi tidak valid.");
  }

  if (header.alg !== "HS256" || header.typ !== "JWT") {
    throw new AuthError("UNAUTHORIZED", 401, "Sesi tidak valid.");
  }

  const expected = Buffer.from(
    signatureFor(`${parts[0]}.${parts[1]}`, secret),
    "base64url",
  );
  const received = Buffer.from(parts[2], "base64url");

  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received) ||
    payload.iss !== TOKEN_ISSUER ||
    payload.aud !== TOKEN_AUDIENCE ||
    typeof payload.sub !== "string" ||
    typeof payload.sid !== "string" ||
    !Number.isInteger(payload.exp) ||
    !Number.isInteger(payload.iat)
  ) {
    throw new AuthError("UNAUTHORIZED", 401, "Sesi tidak valid.");
  }

  if (payload.exp <= Math.floor(now.getTime() / 1000)) {
    throw new AuthError(
      "ACCESS_TOKEN_EXPIRED",
      401,
      "Access token sudah kedaluwarsa.",
    );
  }

  return { userId: payload.sub, sessionId: payload.sid };
}

export function createRefreshToken() {
  return randomBytes(32).toString("base64url");
}

export function hashRefreshToken(token) {
  return createHash("sha256").update(token).digest("hex");
}
