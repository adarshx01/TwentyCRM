/**
 * Minimal Prometheus-compatible registry. A dedicated implementation keeps the
 * dependency surface small; labels are bounded (channel, queue, type, status),
 * never user content or free text.
 */
type Labels = Record<string, string | number>;

function key(labels: Labels): string {
  return Object.keys(labels).sort().map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, '_')}"`).join(',');
}

class Counter {
  readonly values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  get(labels: Labels = {}): number {
    return this.values.get(key(labels)) ?? 0;
  }
}

class Gauge {
  readonly values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  set(labels: Labels, value: number): void {
    this.values.set(key(labels), value);
  }
}

const BUCKETS = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];

class Histogram {
  readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(readonly name: string, readonly help: string) {}
  observe(labels: Labels, seconds: number): void {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { counts: new Array(BUCKETS.length).fill(0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    BUCKETS.forEach((b, i) => { if (seconds <= b) s!.counts[i]++; });
    s.sum += seconds;
    s.count++;
  }
  /** Start a timer; returns a function that records elapsed seconds. */
  startTimer(labels: Labels = {}): () => number {
    const start = process.hrtime.bigint();
    return () => {
      const secs = Number(process.hrtime.bigint() - start) / 1e9;
      this.observe(labels, secs);
      return secs;
    };
  }
}

export class MetricsRegistry {
  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();
  private histograms = new Map<string, Histogram>();

  counter(name: string, help = name): Counter {
    let c = this.counters.get(name);
    if (!c) this.counters.set(name, (c = new Counter(name, help)));
    return c;
  }
  gauge(name: string, help = name): Gauge {
    let g = this.gauges.get(name);
    if (!g) this.gauges.set(name, (g = new Gauge(name, help)));
    return g;
  }
  histogram(name: string, help = name): Histogram {
    let h = this.histograms.get(name);
    if (!h) this.histograms.set(name, (h = new Histogram(name, help)));
    return h;
  }

  render(): string {
    const lines: string[] = [];
    const wrap = (n: string, k: string, v: number) => `${n}${k ? `{${k}}` : ''} ${v}`;
    for (const c of this.counters.values()) {
      lines.push(`# HELP ${c.name} ${c.help}`, `# TYPE ${c.name} counter`);
      for (const [k, v] of c.values) lines.push(wrap(c.name, k, v));
    }
    for (const g of this.gauges.values()) {
      lines.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`);
      for (const [k, v] of g.values) lines.push(wrap(g.name, k, v));
    }
    for (const h of this.histograms.values()) {
      lines.push(`# HELP ${h.name} ${h.help}`, `# TYPE ${h.name} histogram`);
      for (const [k, s] of h.series) {
        const sep = k ? `${k},` : '';
        BUCKETS.forEach((b, i) => lines.push(`${h.name}_bucket{${sep}le="${b}"} ${s.counts[i]}`));
        lines.push(`${h.name}_bucket{${sep}le="+Inf"} ${s.count}`, wrap(`${h.name}_sum`, k, s.sum), wrap(`${h.name}_count`, k, s.count));
      }
    }
    return lines.join('\n') + '\n';
  }

  reset(): void {
    this.counters.clear(); this.gauges.clear(); this.histograms.clear();
  }
}

/** Process-wide registry; one per OS process (api / worker / scheduler). */
export const metrics = new MetricsRegistry();

export const M = {
  webhookReceived: () => metrics.counter('webhook_received_total', 'Inbound webhooks by channel and outcome'),
  webhookDuration: () => metrics.histogram('webhook_accept_duration_seconds', 'Time to durable acceptance'),
  webhookAuthFailures: () => metrics.counter('webhook_auth_failures_total'),
  duplicateSuppressed: () => metrics.counter('duplicate_suppressed_total'),
  draftTransitions: () => metrics.counter('draft_state_transitions_total'),
  crmOpDuration: () => metrics.histogram('crm_operation_duration_seconds'),
  crmOpResults: () => metrics.counter('crm_operations_total'),
  twentyCalls: () => metrics.counter('twenty_api_calls_total'),
  twentyRateDelays: () => metrics.counter('twenty_api_rate_limit_delays_total'),
  jobResults: () => metrics.counter('queue_jobs_total'),
  jobDuration: () => metrics.histogram('queue_job_duration_seconds'),
  queueDepth: () => metrics.gauge('queue_depth'),
  queueOldestAge: () => metrics.gauge('queue_oldest_job_age_seconds'),
  reminderDelay: () => metrics.histogram('reminder_dispatch_delay_seconds'),
  reminderResults: () => metrics.counter('reminder_dispatch_total'),
  aiDuration: () => metrics.histogram('ai_extraction_duration_seconds'),
  tenantUsage: () => metrics.counter('tenant_usage_total'),
  deadLetters: () => metrics.counter('dead_letters_total'),
  intakeResults: () => metrics.counter('intake_records_total'),
  channelHealth: () => metrics.gauge('channel_connection_health'),
  outboundResults: () => metrics.counter('outbound_messages_total'),
};
