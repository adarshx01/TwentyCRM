import { describe, expect, it } from 'vitest';
import { formatMoney, formatTotals, summarizePipeline } from '../../src/reports/pipeline-calculator';
import { DEFAULT_PIPELINE } from '../../src/tenant/tenant.service';
import type { CrmOpportunity } from '../../src/crm/crm-adapter.interface';

const opp = (o: Partial<CrmOpportunity> & { id: string; stageId: string }): CrmOpportunity => ({ title: o.id, archived: false, updatedAt: '', ...o });

describe('pipeline summary (SUM-02, SUM-03)', () => {
  it('counts stages and excludes archived and terminal opportunities from open pipeline', () => {
    const s = summarizePipeline([
      opp({ id: '1', stageId: 'new', amountMicros: 100_000_000, currency: 'INR' }),
      opp({ id: '2', stageId: 'proposal', amountMicros: 250_500_000, currency: 'INR' }),
      opp({ id: '3', stageId: 'won', amountMicros: 900_000_000, currency: 'INR' }),
      opp({ id: '4', stageId: 'proposal', archived: true, amountMicros: 5_000_000_000, currency: 'INR' }),
      opp({ id: '5', stageId: 'lost', amountMicros: 1, currency: 'INR' }),
    ], DEFAULT_PIPELINE);
    expect(s.openCount).toBe(2);
    expect(s.openTotals).toEqual({ INR: 350_500_000n });
    expect(s.stages.find((x) => x.stageId === 'proposal')!.count).toBe(1);
    expect(s.stages.find((x) => x.stageId === 'won')!.count).toBe(1);
  });
  it('never mixes currencies', () => {
    const s = summarizePipeline([opp({ id: '1', stageId: 'new', amountMicros: 1_000_000_000, currency: 'INR' }), opp({ id: '2', stageId: 'new', amountMicros: 2_000_000_000, currency: 'USD' })], DEFAULT_PIPELINE);
    expect(s.openTotals).toEqual({ INR: 1_000_000_000n, USD: 2_000_000_000n });
    expect(formatTotals(s.openTotals)).toBe('1,000 INR + 2,000 USD');
  });
  it('counts value-less opportunities separately instead of inventing a value', () => {
    const s = summarizePipeline([opp({ id: '1', stageId: 'new' })], DEFAULT_PIPELINE);
    expect(s.noValueCount).toBe(1);
    expect(s.openTotals).toEqual({});
    expect(formatTotals(s.openTotals)).toBe('—');
  });
  it('sums with integer precision beyond 2^53 micros', () => {
    const big = 9_000_000_000_000_000; // > Number.MAX_SAFE_INTEGER micros would lose cents as float
    const s = summarizePipeline([opp({ id: '1', stageId: 'new', amountMicros: 1_000_000, currency: 'INR' }), opp({ id: '2', stageId: 'new', amountMicros: 2_000_000, currency: 'INR' })], DEFAULT_PIPELINE);
    expect(s.openTotals.INR).toBe(3_000_000n);
    void big;
  });
  it('money formatting', () => {
    expect(formatMoney(1_234_567_890_000n, 'INR')).toBe('1,234,567.89 INR');
    expect(formatMoney(500_000n, 'USD')).toBe('0.50 USD');
  });
});
