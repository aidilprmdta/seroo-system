import argon2 from "argon2";

const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
};

export function hashPassword(password) {
  return argon2.hash(password, ARGON2ID_OPTIONS);
}

export function verifyPassword(password, passwordHash) {
  return argon2.verify(passwordHash, password);
}
