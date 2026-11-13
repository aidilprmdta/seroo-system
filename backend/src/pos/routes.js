import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { Hono } from "hono";
import { z } from "zod";
import { createAuthenticationMiddleware } from "../auth/middleware.js";
import { PosError } from "./errors.js";

const ORDER_INCLUDE = {
  items: {
    include: { addOns: true },
  },
};

const decimalString = z
  .string()
  .max(13)
  .regex(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/);

const addOnSchema = z
  .object({
    addOnId: z.string().min(1).max(64),
    quantity: z.number().int().min(1).max(10),
    expectedUnitPrice: decimalString,
  })
  .strict();

const orderItemSchema = z
  .object({
    productVariantId: z.string().min(1).max(64),
    quantity: z.number().int().min(1).max(99),
    expectedVariantPrice: decimalString,
    addOns: z.array(addOnSchema).max(20).default([]),
  })
  .strict()
  .superRefine((item, context) => {
    const ids = item.addOns.map((addOn) => addOn.addOnId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Add-on tidak boleh diduplikasi pada satu item.",
      });
    }
  });

const orderSchema = z
  .object({
    clientTransactionId: z.string().uuid(),
    recordedOffline: z.boolean().default(false),
    paymentMethod: z.enum(["CASH", "QRIS"]),
    items: z.array(orderItemSchema).min(1).max(50),
  })
  .strict();

function readBody(value) {
  const parsed = orderSchema.safeParse(value);
  if (!parsed.success) {
    throw new PosError(
      "VALIDATION_ERROR",
      400,
      "Periksa kembali item dan metode pembayaran.",
    );
  }
  return parsed.data;
}

async function readJson(c) {
  try {
    return await c.req.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new PosError(
        "VALIDATION_ERROR",
        400,
        "Format permintaan tidak valid.",
      );
    }
    throw error;
  }
}

function assertOutletId(outletId) {
  if (!outletId || outletId.length > 64) {
    throw new PosError("VALIDATION_ERROR", 400, "Outlet tidak valid.");
  }
}

async function requireCrewMembership(prisma, userId, outletId) {
  const membership = await prisma.outletMembership.findUnique({
    where: {
      userId_outletId: { userId, outletId },
    },
    include: {
      outlet: { select: { isActive: true } },
    },
  });

  if (
    !membership ||
    membership.role !== "CREW" ||
    !membership.outlet?.isActive
  ) {
    throw new PosError(
      "FORBIDDEN",
      403,
      "Akses ke outlet atau tindakan ini tidak diizinkan.",
    );
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function hashPayload(payload) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)))
    .digest("hex");
}

function idempotencyWhere({ outletId, crewId, clientTransactionId }) {
  return {
    outletId_crewId_clientTransactionId: {
      outletId,
      crewId,
      clientTransactionId,
    },
  };
}

function orderDto(order) {
  return {
    id: order.id,
    clientTransactionId: order.clientTransactionId,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    subtotal: order.subtotal.toString(),
    total: order.total.toString(),
    createdAt: order.createdAt.toISOString(),
    items: order.items.map((item) => ({
      id: item.id,
      productVariantId: item.productVariantId,
      productName: item.productName,
      variantName: item.variantName,
      quantity: item.quantity,
      unitPrice: item.unitPrice.toString(),
      subtotal: item.subtotal.toString(),
      addOns: item.addOns.map((addOn) => ({
        addOnId: addOn.addOnId,
        name: addOn.addOnName,
        quantity: addOn.quantity,
        unitPrice: addOn.unitPrice.toString(),
      })),
    })),
  };
}

function existingOrderResult(order, payloadDigest) {
  if (order.payloadHash !== payloadDigest) {
    throw new PosError(
      "IDEMPOTENCY_KEY_REUSED",
      409,
      "ID transaksi sudah digunakan dengan isi yang berbeda.",
    );
  }
  return order;
}

function asDecimal(value) {
  return new Prisma.Decimal(value.toString());
}

function assertOfflinePricesMatch(payload, variants, addOns) {
  for (const item of payload.items) {
    const variant = variants.get(item.productVariantId);
    if (!asDecimal(item.expectedVariantPrice).equals(variant.price)) {
      throw new PosError(
        "PRICE_CHANGED",
        409,
        "Harga katalog berubah. Periksa kembali keranjang sebelum mengirim.",
      );
    }

    for (const selection of item.addOns) {
      const addOn = addOns.get(selection.addOnId);
      if (!asDecimal(selection.expectedUnitPrice).equals(addOn.price)) {
        throw new PosError(
          "PRICE_CHANGED",
          409,
          "Harga katalog berubah. Periksa kembali keranjang sebelum mengirim.",
        );
      }
    }
  }
}

async function createOrder({
  prisma,
  outletId,
  crewId,
  payload,
  now,
  orderNumberFactory,
}) {
  const payloadDigest = hashPayload(payload);
  const uniqueWhere = idempotencyWhere({
    outletId,
    crewId,
    clientTransactionId: payload.clientTransactionId,
  });
  const existing = await prisma.order.findUnique({
    where: uniqueWhere,
    include: ORDER_INCLUDE,
  });
  if (existing) {
    return { order: existingOrderResult(existing, payloadDigest), replayed: true };
  }

  try {
    const order = await prisma.$transaction(async (tx) => {
      const transactionExisting = await tx.order.findUnique({
        where: uniqueWhere,
        include: ORDER_INCLUDE,
      });
      if (transactionExisting) {
        return existingOrderResult(transactionExisting, payloadDigest);
      }

      const variantIds = [...new Set(payload.items.map((item) => item.productVariantId))];
      const variantsResult = await tx.productVariant.findMany({
        where: {
          id: { in: variantIds },
          isActive: true,
          product: { isActive: true },
        },
        include: { product: { select: { id: true, name: true, isActive: true } } },
      });
      const variants = new Map(variantsResult.map((item) => [item.id, item]));
      if (variants.size !== variantIds.length) {
        throw new PosError(
          "CATALOG_ITEM_UNAVAILABLE",
          409,
          "Produk atau varian sudah tidak tersedia. Muat ulang katalog.",
        );
      }

      const addOnIds = [
        ...new Set(payload.items.flatMap((item) => item.addOns.map((addOn) => addOn.addOnId))),
      ];
      const addOnsResult = addOnIds.length
        ? await tx.addOn.findMany({
            where: { id: { in: addOnIds }, isActive: true },
          })
        : [];
      const addOns = new Map(addOnsResult.map((item) => [item.id, item]));
      if (addOns.size !== addOnIds.length) {
        throw new PosError(
          "CATALOG_ITEM_UNAVAILABLE",
          409,
          "Add-on sudah tidak tersedia. Muat ulang katalog.",
        );
      }

      if (payload.recordedOffline) {
        assertOfflinePricesMatch(payload, variants, addOns);
      }

      let total = new Prisma.Decimal(0);
      const items = payload.items.map((item) => {
        const variant = variants.get(item.productVariantId);
        const addOnSelections = item.addOns.map((selection) => {
          const addOn = addOns.get(selection.addOnId);
          if (addOn.price.lt(0)) {
            throw new PosError(
              "CATALOG_ITEM_UNAVAILABLE",
              409,
              "Harga katalog tidak valid. Hubungi pengelola.",
            );
          }
          return {
            addOnId: addOn.id,
            addOnName: addOn.name,
            quantity: selection.quantity,
            unitPrice: addOn.price,
          };
        });

        if (variant.price.lt(0)) {
          throw new PosError(
            "CATALOG_ITEM_UNAVAILABLE",
            409,
            "Harga katalog tidak valid. Hubungi pengelola.",
          );
        }

        const perUnit = addOnSelections.reduce(
          (lineTotal, addOn) =>
            lineTotal.add(addOn.unitPrice.mul(addOn.quantity)),
          variant.price,
        );
        const lineSubtotal = perUnit.mul(item.quantity);
        total = total.add(lineSubtotal);

        return {
          productVariantId: variant.id,
          productName: variant.product.name,
          variantName: variant.name,
          quantity: item.quantity,
          unitPrice: variant.price,
          subtotal: lineSubtotal,
          addOns: { create: addOnSelections },
        };
      });

      const createdAt = now();
      return tx.order.create({
        data: {
          outletId,
          crewId,
          orderNumber: orderNumberFactory(),
          clientTransactionId: payload.clientTransactionId,
          payloadHash: payloadDigest,
          status: "COMPLETED",
          paymentMethod: payload.paymentMethod,
          paymentStatus:
            payload.recordedOffline && payload.paymentMethod === "QRIS"
              ? "PENDING_RECONCILIATION"
              : "RECORDED",
          subtotal: total,
          total,
          createdAt,
          completedAt: createdAt,
          items: {
            create: items,
          },
        },
        include: ORDER_INCLUDE,
      });
    });

    return { order, replayed: false };
  } catch (error) {
    if (error?.code !== "P2002") {
      throw error;
    }
    const racedOrder = await prisma.order.findUnique({
      where: uniqueWhere,
      include: ORDER_INCLUDE,
    });
    if (!racedOrder) {
      throw error;
    }
    return {
      order: existingOrderResult(racedOrder, payloadDigest),
      replayed: true,
    };
  }
}

export function createPosRoutes({
  prisma,
  accessTokenSecret,
  now = () => new Date(),
  orderNumberFactory = randomUUID,
}) {
  const routes = new Hono();
  const authenticate = createAuthenticationMiddleware({
    prisma,
    accessTokenSecret,
    now,
  });

  routes.get("/:outletId/catalog", authenticate, async (c) => {
    const outletId = c.req.param("outletId");
    assertOutletId(outletId);
    const auth = c.get("auth");
    await requireCrewMembership(prisma, auth.userId, outletId);

    const [products, addOns] = await Promise.all([
      prisma.product.findMany({
        where: {
          isActive: true,
          variants: { some: { isActive: true } },
        },
        select: {
          id: true,
          name: true,
          category: true,
          variants: {
            where: { isActive: true },
            select: { id: true, name: true, price: true },
            orderBy: { name: "asc" },
          },
        },
        orderBy: { name: "asc" },
      }),
      prisma.addOn.findMany({
        where: { isActive: true },
        select: { id: true, name: true, price: true },
        orderBy: { name: "asc" },
      }),
    ]);

    return c.json({
      success: true,
      data: {
        outletId,
        products: products.map((product) => ({
          ...product,
          variants: product.variants.map((variant) => ({
            ...variant,
            price: variant.price.toString(),
          })),
        })),
        addOns: addOns.map((addOn) => ({
          ...addOn,
          price: addOn.price.toString(),
        })),
      },
    });
  });

  routes.post("/:outletId/orders", authenticate, async (c) => {
    const outletId = c.req.param("outletId");
    assertOutletId(outletId);
    const auth = c.get("auth");
    await requireCrewMembership(prisma, auth.userId, outletId);

    const payload = readBody(await readJson(c));
    const result = await createOrder({
      prisma,
      outletId,
      crewId: auth.userId,
      payload,
      now,
      orderNumberFactory,
    });

    return c.json(
      {
        success: true,
        data: {
          order: orderDto(result.order),
          replayed: result.replayed,
        },
      },
      result.replayed ? 200 : 201,
    );
  });

  return routes;
}
