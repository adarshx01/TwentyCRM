import { AsyncLocalStorage } from 'node:async_hooks';
import { generateCorrelationId } from '../utils/crypto.util';

export interface AsyncContext {
  correlationId: string;
  tenantId?: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<AsyncContext>();

export function runWithContext<T>(ctx: Partial<AsyncContext>, fn: () => T): T {
  const parent = storage.getStore();
  return storage.run(
    { correlationId: ctx.correlationId ?? parent?.correlationId ?? generateCorrelationId(), tenantId: ctx.tenantId ?? parent?.tenantId, userId: ctx.userId ?? parent?.userId },
    fn,
  );
}

export function currentContext(): AsyncContext | undefined {
  return storage.getStore();
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/** Enrich the active context (e.g. once the tenant is resolved). */
export function enrichContext(patch: Partial<AsyncContext>): void {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}
