import { Type } from "typebox";

// Keep the wire schema portable to JSON-schema-to-grammar converters.
// AftercareService rejects whitespace-only IDs independently of model generation.
export const IdSchema = Type.String({ minLength: 1, maxLength: 120, description: "1–120 字符的非空白标识，使用工具返回的原始值。" });
const quantity = Type.Integer({ minimum: 1 });
export const ActionSchema = Type.Union([
  Type.Object({ kind: Type.Literal("return"), lineId: IdSchema, quantity }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("exchange"), lineId: IdSchema, quantity, targetVariantId: IdSchema }, { additionalProperties: false }),
]);
export const QuoteInputSchema = Type.Object({
  orderId: IdSchema,
  actions: Type.Array(ActionSchema, { minItems: 1, maxItems: 20 }),
}, { additionalProperties: false });
export const CreateRequestSchema = Type.Object({
  quoteId: IdSchema,
  confirmationId: IdSchema,
  idempotencyKey: IdSchema,
}, { additionalProperties: false });
export const ConfirmSchema = Type.Object({ confirmed: Type.Literal(true) }, { additionalProperties: false });
export const OrderIdSchema = Type.Object({ orderId: IdSchema }, { additionalProperties: false });
export const LineLookupSchema = Type.Object({ orderId: IdSchema, lineId: IdSchema }, { additionalProperties: false });
export const OperationLookupSchema = Type.Object({ idempotencyKey: IdSchema }, { additionalProperties: false });
