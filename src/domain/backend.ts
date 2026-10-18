import type { AftercareService } from './aftercare.js';

type Awaitable<T> = T | Promise<T>;
export type AftercareBackend = {
  [K in 'getOrder' | 'getPolicy' | 'listVariants' | 'quote' | 'confirmQuote' | 'getRequest' | 'getOperation' | 'createRequest' | 'listPendingQuotes']:
    (...args: Parameters<AftercareService[K]>) => Awaitable<ReturnType<AftercareService[K]>>;
};
export type OperationResult = ReturnType<AftercareService['getOperation']>;
