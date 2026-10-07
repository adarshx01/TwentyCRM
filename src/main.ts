import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from './config/configuration';
import { configureLogging, getLogger } from './observability/logger';
import { startTracing } from './observability/tracing';
import { AppModule } from './app.module';
import { configureHttp } from './http-setup';
import { QueueService } from './queue/queue.service';
import { WorkersService } from './workers/workers.service';
import { LIMITER_BACKEND, type LimiterBackend } from './ratelimit/limiter';

/**
 * One image, several process roles so each tier scales independently:
 *   api        webhooks + employee API + admin API; verifies, persists, enqueues (no job consumers)
 *   worker     queue consumers (AI, CRM, outbound, reminders, intake, reconciliation)
 *   scheduler  single-instance cron producers (digest tick, planner, maintenance, fan-out)
 *   all        everything (development / very small installs)
 * Every role serves /health, /health/ready and /metrics.
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();
  configureLogging(config.app.logLevel, config.app.nodeEnv === 'development');
  const log = getLogger('bootstrap');
  const stopTracing = await startTracing(config.observability.otlpEndpoint, `crm-bee-${config.app.role}`);

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ bodyLimit: 24 * 1024 * 1024, trustProxy: true }), { logger: ['error', 'warn'], bufferLogs: false, rawBody: true });
  await configureHttp(app);

  const role = config.app.role;
  const queue = app.get(QueueService);
  const workers = app.get(WorkersService);
  await queue.start({ supervise: role !== 'api', schedule: role === 'scheduler' || role === 'all' });
  if (role === 'worker' || role === 'all') await workers.startWorkers();
  if (role === 'scheduler' || role === 'all') await workers.startScheduler();

  await app.listen(config.app.port, '0.0.0.0');
  log.info({ role, port: config.app.port }, 'crm-bee started');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'graceful shutdown: draining');
    const force = setTimeout(() => { log.error('shutdown timed out; exiting'); process.exit(1); }, 40_000);
    try {
      await app.close();                         // stop accepting HTTP
      await queue.stop(25_000);                  // finish in-flight jobs, stop claiming new ones
      await app.get<LimiterBackend>(LIMITER_BACKEND).close();
      await stopTracing();
      clearTimeout(force);
      process.exit(0);
    } catch (e) { log.error({ err: (e as Error).message }, 'error during shutdown'); process.exit(1); }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((e) => { console.error(e); process.exit(1); });
