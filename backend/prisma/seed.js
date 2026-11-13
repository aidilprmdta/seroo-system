import { PrismaClient } from "@prisma/client";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const provisionalExpenseCategories = Object.freeze([
  "Es batu",
  "Air galon",
  "Gas",
  "Perlengkapan",
  "Bahan baku darurat",
  "Listrik",
  "Penggajian",
  "Lainnya",
]);

export async function seedProvisionalExpenseCategories(prisma) {
  for (const name of provisionalExpenseCategories) {
    await prisma.expenseCategory.upsert({
      where: { name },
      create: { name, isProvisional: true },
      update: {},
    });
  }
}

async function main() {
  const prisma = new PrismaClient();

  try {
    await seedProvisionalExpenseCategories(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(
      "Expense category seed failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    process.exitCode = 1;
  });
}
