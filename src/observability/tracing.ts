import { getLogger } from './logger';

/**
 * OpenTelemetry bootstrap. Only activates when OTEL_EXPORTER_OTLP_ENDPOINT is set,
 * so local runs and tests have no exporter overhead. Correlation IDs (logs/audit)
 * work independently of tracing.
 */
export async function startTracing(endpoint: string | undefined, serviceName: string): Promise<() => Promise<void>> {
  if (!endpoint) return async () => undefined;
  const log = getLogger('tracing');
  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { Resource } = await import('@opentelemetry/resources');
    const sdk = new NodeSDK({
      resource: new Resource({ 'service.name': serviceName }),
      traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    });
    sdk.start();
    log.info({ endpoint }, 'tracing started');
    return async () => { await sdk.shutdown(); };
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'tracing failed to start; continuing without it');
    return async () => undefined;
  }
}
