import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';

export const C = {
  border: '1px solid rgba(128,128,128,.25)',
  muted: { opacity: 0.7, fontSize: 12 } as CSSProperties,
  accent: '#3b5bdb',
  danger: '#e03131',
  ok: '#2f9e44',
};

export const Card = ({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) => (
  <section style={{ border: C.border, borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
    {title || actions ? (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div style={{ display: 'flex', gap: 8 }}>{actions}</div>
      </div>
    ) : null}
    {children}
  </section>
);

export const Btn = ({ children, onClick, kind = 'default', disabled }: { children: ReactNode; onClick?: () => void; kind?: 'default' | 'primary' | 'danger'; disabled?: boolean }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    style={{
      padding: '5px 10px', borderRadius: 6, fontSize: 13, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
      border: kind === 'default' ? C.border : 'none', color: kind === 'default' ? 'inherit' : '#fff',
      background: kind === 'primary' ? C.accent : kind === 'danger' ? C.danger : 'transparent',
    }}
  >
    {children}
  </button>
);

export const Badge = ({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'ok' | 'warn' | 'danger' | 'accent' }) => {
  const bg = { muted: 'rgba(128,128,128,.18)', ok: 'rgba(47,158,68,.2)', warn: 'rgba(240,140,0,.22)', danger: 'rgba(224,49,49,.22)', accent: 'rgba(59,91,219,.22)' }[tone];
  return <span style={{ background: bg, borderRadius: 6, padding: '2px 7px', fontSize: 12, whiteSpace: 'nowrap' }}>{children}</span>;
};

const inputStyle: CSSProperties = { padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit', fontSize: 13 };

export const TextInput = ({ value, onChange, placeholder, width }: { value: string; onChange: (v: string) => void; placeholder?: string; width?: number }) => (
  <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, width: width ?? 180 }} />
);

export const Select = ({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) => (
  <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
    {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
  </select>
);

export const Row = ({ children, gap = 8 }: { children: ReactNode; gap?: number }) => <div style={{ display: 'flex', gap, alignItems: 'center', flexWrap: 'wrap' }}>{children}</div>;

export const Notice = ({ tone, children }: { tone: 'error' | 'ok' | 'info'; children: ReactNode }) => (
  <div style={{ fontSize: 13, padding: '8px 10px', borderRadius: 6, background: tone === 'error' ? 'rgba(224,49,49,.15)' : tone === 'ok' ? 'rgba(47,158,68,.15)' : 'rgba(59,91,219,.12)' }}>{children}</div>
);

/** Rows of label/value pairs. */
export const Pairs = ({ rows }: { rows: Array<[string, ReactNode]> }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '6px 12px', fontSize: 13 }}>
    {rows.map(([k, v]) => [<div key={`${k}-k`} style={C.muted}>{k}</div>, <div key={`${k}-v`}>{v}</div>])}
  </div>
);

export const Table = ({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) =>
  rows.length === 0 ? (
    <div style={C.muted}>{empty}</div>
  ) : (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${head.length}, minmax(0, auto))`, gap: '8px 14px', fontSize: 13, alignItems: 'center', overflowX: 'auto' }}>
      {head.map((h) => <div key={h} style={{ ...C.muted, fontWeight: 600 }}>{h}</div>)}
      {rows.flatMap((r, i) => r.map((cell, j) => <div key={`${i}-${j}`} style={{ minWidth: 0 }}>{cell}</div>))}
    </div>
  );

/** Load data, expose reload + error; actions report their own result. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await load()); setError(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload };
}

/** Run an action with a busy flag and a result message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); if (ok) setMsg({ tone: 'ok', text: ok }); } catch (e) { setMsg({ tone: 'error', text: e instanceof Error ? e.message : String(e) }); } finally { setBusy(false); }
  };
  return { busy, msg, run, setMsg };
}

export const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');
