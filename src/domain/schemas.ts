import { Type } from "typebox";

export const IdSchema = Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" });
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
