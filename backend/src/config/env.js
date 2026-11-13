import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => {
      const { protocol } = new URL(value);
      return protocol === "postgres:" || protocol === "postgresql:";
    }, "must be a PostgreSQL connection URL"),
  JWT_ACCESS_SECRET: z.string().min(32),
});

export function parseEnv(source) {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const invalidNames = [
      ...new Set(
        result.error.issues
          .map((issue) => issue.path[0])
          .filter(Boolean)
          .map(String),
      ),
    ];

    throw new Error(`Invalid environment configuration: ${invalidNames.join(", ")}`);
  }

  return result.data;
}
