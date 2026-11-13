export class AuthError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

export function invalidCredentials() {
  return new AuthError(
    "INVALID_CREDENTIALS",
    401,
    "Email atau password tidak valid.",
  );
}
