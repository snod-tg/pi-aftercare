import type { AftercareBackend } from '../domain/backend.js';
import type { SavedSession } from '../storage/sessions.js';
import type { WebSnapshot } from './web-types.js';

export async function buildSessionSnapshot(
  service: AftercareBackend,
  session: SavedSession,
): Promise<WebSnapshot> {
  const { actor, checkpoint, currentOrderId } = session;
  const { orders, completedRequests, targetSizes } = await service.readSessionData(actor, {
    orderIds: [
      ...(currentOrderId ? [currentOrderId] : []),
      ...session.requests.map((request) => request.orderId),
    ],
    operationKeys: checkpoint.receipts.map((receipt) => receipt.idempotencyKey),
    quotes: checkpoint.quotes,
  });
  // Recover receipts even when a process died immediately after the business write committed.
  const requests = new Map(
    [...session.requests, ...completedRequests].map((request) => [request.id, request]),
  );
  const completed = new Set([...requests.values()].map((request) => request.quoteId));
  // Older checkpoints did not record the selected order.
  const orderId =
    currentOrderId ?? checkpoint.quotes.at(-1)?.orderId ?? [...requests.values()].at(-1)?.orderId;
  const quotes = checkpoint.quotes
    .filter((quote) => !completed.has(quote.id))
    .map((quote) => {
      const source = orders.get(quote.orderId);
      const descriptions = quote.actions.map((action) => {
        const name = source?.lines.find((item) => item.id === action.lineId)?.name ?? action.lineId;
        if (action.kind === 'return') return `退货 · ${name} × ${action.quantity}`;
        const size = targetSizes.get(action.targetVariantId) ?? action.targetVariantId;
        return `换货 · ${name} → ${size} 码 × ${action.quantity}`;
      });
      return { ...quote, descriptions };
    });
  return {
    id: session.id,
    busy: session.busy,
    order: orderId ? (orders.get(orderId) ?? null) : null,
    messages: session.messages,
    quotes,
    requests: [...requests.values()],
    evidence: session.evidence,
    trace: session.trace,
    ...(session.lastRun ? { lastRun: session.lastRun } : {}),
  };
}
