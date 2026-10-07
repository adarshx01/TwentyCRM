import type { CrmOpportunity } from '../crm/crm-adapter.interface';
import type { PipelineConfig } from '../database/schema';

export type CurrencyTotals = Record<string, bigint>;

export interface StageRow { stageId: string; label: string; count: number; totals: CurrencyTotals; terminal?: 'won' | 'lost' }
export interface PipelineSummary { stages: StageRow[]; openCount: number; openTotals: CurrencyTotals; noValueCount: number }

function add(t: CurrencyTotals, o: CrmOpportunity): void {
  if (o.amountMicros == null || !o.currency) return;
  t[o.currency] = (t[o.currency] ?? 0n) + BigInt(Math.trunc(o.amountMicros));
}

/**
 * Open pipeline = non-archived, non-terminal opportunities (SUM-03). Amounts are summed
 * per ISO currency with integer micros; currencies are NEVER mixed or converted (SUM-02).
 */
export function summarizePipeline(opps: CrmOpportunity[], pipeline: PipelineConfig): PipelineSummary {
  const rows = new Map<string, StageRow>();
  for (const s of [...pipeline.stages].sort((a, b) => a.order - b.order)) rows.set(s.id, { stageId: s.id, label: s.label, count: 0, totals: {}, terminal: s.terminalType });
  const openTotals: CurrencyTotals = {};
  let openCount = 0; let noValueCount = 0;
  for (const o of opps) {
    if (o.archived) continue;
    const row = rows.get(o.stageId);
    if (!row) continue;
    row.count++; add(row.totals, o);
    if (!row.terminal) {
      openCount++; add(openTotals, o);
      if (o.amountMicros == null) noValueCount++;
    }
  }
  return { stages: [...rows.values()], openCount, openTotals, noValueCount };
}

export function formatMoney(micros: bigint, currency: string): string {
  const neg = micros < 0n; const abs = neg ? -micros : micros;
  const whole = abs / 1_000_000n; const frac = abs % 1_000_000n / 10_000n;
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${w}${frac ? `.${frac.toString().padStart(2, '0')}` : ''} ${currency}`;
}

export const formatTotals = (t: CurrencyTotals): string => {
  const parts = Object.entries(t).sort(([a], [b]) => a.localeCompare(b)).map(([c, v]) => formatMoney(v, c));
  return parts.length ? parts.join(' + ') : '—';
};
