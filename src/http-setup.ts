import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { generateCorrelationId } from './common/utils/crypto.util';
import { runWithContext } from './common/context/request-context';

/**
 * HTTP hardening shared by production and tests:
 *  - raw body is enabled at app creation (`rawBody: true`) because webhook HMACs cover the exact bytes
 *  - correlation ID per request (propagated to logs, jobs, audit)
 *  - security headers, no content sniffing
 */
export async function configureHttp(app: NestFastifyApplication): Promise<void> {
  const fastify = app.getHttpAdapter().getInstance() as any; // loosely typed: Nest bundles its own Fastify typings
  fastify.addHook('onRequest', (req: FastifyRequest, reply: any, done: () => void) => {
    const incoming = req.headers['x-correlation-id'];
    const id = typeof incoming === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : generateCorrelationId();
    reply.header('x-correlation-id', id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
    runWithContext({ correlationId: id }, () => done());
  });
}
