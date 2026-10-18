import type { Actor, DemoState, Order, Variant } from "./types.js";

export const DEMO_ALICE: Actor = { merchantId: "M-DEMO", customerId: "C-ALICE" };
export const DEMO_BOB: Actor = { merchantId: "M-DEMO", customerId: "C-BOB" };

export function createDemoState(now = new Date()): DemoState {
  const variants: Variant[] = [
    { id: "SKU-TEE-M", productId: "P-TEE", name: "纯棉白色 T 恤", size: "M", stock: 10, version: 1 },
    { id: "SKU-TEE-L", productId: "P-TEE", name: "纯棉白色 T 恤", size: "L", stock: 2, version: 1 },
    { id: "SKU-TEE-XL", productId: "P-TEE", name: "纯棉白色 T 恤", size: "XL", stock: 0, version: 1 },
    { id: "SKU-JACKET-M", productId: "P-JACKET", name: "轻薄外套", size: "M", stock: 5, version: 1 },
  ];
  const order: Order = {
    id: "O-1001",
    ...DEMO_ALICE,
    status: "delivered",
    deliveredAt: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
    currency: "CNY",
    version: 1,
    lines: [
      { id: "LINE-TEE", variantId: "SKU-TEE-M", name: "纯棉白色 T 恤 M", quantity: 1, requestedQuantity: 0, paidUnitCents: 9900 },
      { id: "LINE-JACKET", variantId: "SKU-JACKET-M", name: "轻薄外套 M", quantity: 1, requestedQuantity: 0, paidUnitCents: 19900 },
    ],
  };
  return {
    policy: {
      version: "demo-v1",
      returnWindowDays: 30,
      quoteTtlMinutes: 10,
      source: "模拟商家售后政策 / demo-v1",
      clauses: [
        { id: "window", text: "签收后 30 天内可申请退换货，商品需保持完整；商品状态由人工验收。" },
        { id: "exchange", text: "同款不同尺码可以换货，不补差价；目标尺码必须有库存。" },
        { id: "refund", text: "退货金额按订单实付金额计算，原路退回；本模拟环境只创建申请，不实际退款。" },
        { id: "confirmation", text: "提交前必须由用户确认具体方案；创建申请后等待寄回，不能视作退款完成。" },
      ],
    },
    orders: new Map([
      [order.id, order],
      ["O-2001", { ...structuredClone(order), id: "O-2001", ...DEMO_BOB }],
    ]),
    variants: new Map(variants.map((variant) => [variant.id, variant])),
    quotes: new Map(),
    confirmations: new Map(),
    requests: new Map(),
    operations: new Map(),
  };
}
