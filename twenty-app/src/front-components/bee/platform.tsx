import { useEffect, useRef, useState } from 'react';
import { bee, type Company, type CompanyDetail, type OperatorRow, type PlatformAuditRow, type PlatformHealth, type Provisioning } from './api';
import { Badge, Btn, C, Card, Notice, Pairs, Row, Select, Table, TextInput, fmt, useAction, useLoad } from './ui';

const ZONES = ['Asia/Kolkata', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Singapore', 'Australia/Sydney', 'UTC'].map((z) => ({ value: z, label: z }));
const CURRENCIES = ['INR', 'GBP', 'USD', 'EUR', 'AED', 'SGD', 'AUD'].map((c) => ({ value: c, label: c }));
const statusTone = (s: string) => (s === 'active' ? 'ok' : s === 'suspended' ? 'danger' : 'muted') as 'ok' | 'danger' | 'muted';
const slugOf = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

// ── one company ─────────────────────────────────────────────
const CompanyView = ({ id, onBack }: { id: string; onBack: () => void }) => {
  const d = useLoad(() => bee<CompanyDetail>('GET', `/v1/platform/companies/${id}`), [id]);
  const act = useAction();
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState('4');
  const c = d.data;
  const run = (path: string, ok: string, body: unknown = {}) => act.run(async () => { await bee('POST', `/v1/platform/companies/${id}/${path}`, body); await d.reload(); }, ok);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Row><Btn onClick={onBack}>← Companies</Btn>{c ? <span style={{ fontWeight: 600, fontSize: 16 }}>{c.name}</span> : null}{c ? <Badge tone={statusTone(c.status)}>{c.status}</Badge> : null}</Row>
      {d.error ? <Notice tone="error">{d.error}</Notice> : null}
      {act.msg ? <Notice tone={act.msg.tone}>{act.msg.text}</Notice> : null}
      {c ? (
        <>
          <Card title="Company">
            <Pairs rows={[
              ['Workspace', c.workspaceUrl ?? '—'],
              ['Address / slug', c.slug],
              ['Time zone · currency', `${c.timezone} · ${c.currency}`],
              ['Morning reminder', `${c.morningReminderTime} on days ${c.workingDays.join(', ')}`],
              ['Configuration version', String(c.configVersion)],
              ['Pipeline', c.pipeline.map((s) => s.label).join(' → ')],
              ['Bee service account', c.serviceUser ?? '—'],
              ['Failed jobs (open)', String(c.openDeadLetters)],
            ]} />
            <Row>
              {c.status === 'active'
                ? <Btn kind="danger" disabled={act.busy} onClick={() => run('suspend', 'Suspended: no one in this company can use Bee until it is reactivated.')}>Suspend</Btn>
                : <Btn kind="primary" disabled={act.busy} onClick={() => run('reactivate', 'Reactivated.')}>Reactivate</Btn>}
              <Btn disabled={act.busy} onClick={() => run('resync', 'Twenty roles re-applied from Bee.')}>Re-sync access</Btn>
              <Btn disabled={act.busy} onClick={() => run('configure-app', 'Bee app re-configured in the workspace.')}>Re-configure app</Btn>
              <Btn disabled={act.busy} onClick={() => run('upgrade-app', 'Bee app updated to the newest published version (or already current).')}>Update Bee app</Btn>
            </Row>
          </Card>
          <Card title={`People (${c.users.length}) — names and roles only, never CRM data`}>
            <Table
              head={['Name', 'E-mail', 'Role', 'Team', 'Twenty account', 'Status']}
              empty="No users."
              rows={c.users.map((u) => [u.name, u.email ?? '—', u.role, u.team ?? '—', u.linked ? <Badge tone="ok">linked</Badge> : u.invited ? <Badge tone="accent">invited</Badge> : <Badge>not linked</Badge>, <Badge tone={u.status === 'active' ? 'ok' : 'danger'}>{u.status}</Badge>])}
            />
          </Card>
          <Card title="Usage (last 30 days)">
            <Table head={['Kind', 'Total', 'Events']} empty="No usage yet." rows={c.usage30d.map((u) => [u.kind, u.total, u.events])} />
          </Card>
          <Card title="Support access">
            <div style={C.muted}>You cannot see this company's CRM data. If you need to help, request access with a reason; the company's admin approves it for a limited time and every use is audited.</div>
            <Table
              head={['Operator', 'Reason', 'Duration', 'Status']}
              empty="No support requests."
              rows={c.supportGrants.map((g) => [g.operator ?? '—', g.reason, `${g.hours} h`, <Badge tone={g.state === 'active' ? 'warn' : g.state === 'requested' ? 'accent' : 'muted'}>{g.state}{g.state === 'active' && g.expiresAt ? ` until ${fmt(g.expiresAt)}` : ''}</Badge>])}
            />
            <Row>
              <TextInput value={reason} onChange={setReason} placeholder="Why do you need access? (10+ characters)" width={340} />
              <Select value={hours} onChange={setHours} options={['1', '2', '4', '8', '24'].map((h) => ({ value: h, label: `${h} h` }))} />
              <Btn disabled={act.busy || reason.trim().length < 10} onClick={() => act.run(async () => { await bee('POST', `/v1/platform/companies/${id}/support-request`, { reason: reason.trim(), hours: Number(hours) }); setReason(''); await d.reload(); }, 'Request sent to the company admin.')}>Request access</Btn>
            </Row>
          </Card>
        </>
      ) : null}
    </div>
  );
};

// ── companies list + in-progress ────────────────────────────
const Companies = ({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) => {
  const list = useLoad(() => bee<Company[]>('GET', '/v1/platform/companies'));
  const prog = useLoad(() => bee<Provisioning[]>('GET', '/v1/platform/companies/in-progress'));
  const act = useAction();
  const open = (prog.data ?? []).filter((p) => p.state !== 'ready');
  const anyRunning = open.some((p) => p.state === 'running');
  // A creation running in the background: follow it until it is ready or has stopped.
  useEffect(() => {
    if (!anyRunning) return undefined;
    const t = setInterval(() => { void prog.reload(); void list.reload(); }, 3000);
    return () => clearInterval(t);
  }, [anyRunning]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {act.msg ? <Notice tone={act.msg.tone}>{act.msg.text}</Notice> : null}
      {open.length ? (
        <Card title="Creation not finished">
          {open.map((p) => (
            <div key={p.slug} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div><b>{p.name ?? p.slug}</b> <Badge tone={p.state === 'failed' ? 'danger' : 'warn'}>{p.state}</Badge> <span style={C.muted}>done: {p.steps.join(' · ') || 'nothing yet'}</span></div>
              {p.error ? <Notice tone="error">{p.error}</Notice> : null}
              {p.state === 'failed' ? <Row><Btn kind="primary" disabled={act.busy} onClick={() => act.run(async () => { await bee('POST', '/v1/platform/companies', p.request); await Promise.all([list.reload(), prog.reload()]); }, `Continuing ${p.name ?? p.slug}…`)}>Resume</Btn></Row> : null}
            </div>
          ))}
        </Card>
      ) : null}
      <Card title={`Companies (${(list.data ?? []).length})`} actions={<><Btn onClick={() => { void list.reload(); void prog.reload(); }}>Refresh</Btn><Btn kind="primary" onClick={onNew}>+ New company</Btn></>}>
        {list.error ? <Notice tone="error">{list.error}</Notice> : null}
        <Table
          head={['Company', 'Workspace', 'People', 'Status', 'Health', '']}
          empty="No companies yet. Create the first one."
          rows={(list.data ?? []).map((c) => [
            <span><b>{c.name}</b><div style={C.muted}>{c.slug} · {c.timezone} · {c.currency}</div></span>,
            <span style={{ fontSize: 12 }}>{c.workspaceUrl ?? '—'}</span>,
            `${c.users.active} active${c.users.revoked ? ` · ${c.users.revoked} revoked` : ''}`,
            <Badge tone={statusTone(c.status)}>{c.status}</Badge>,
            <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {c.openDeadLetters ? <Badge tone="danger">{c.openDeadLetters} failed jobs</Badge> : <Badge tone="ok">no failed jobs</Badge>}
              {c.pendingSupportRequests ? <Badge tone="accent">{c.pendingSupportRequests} support request</Badge> : null}
              {c.reconciliationError ? <Badge tone="warn">sync issue</Badge> : null}
            </span>,
            <Btn onClick={() => onOpen(c.id)}>Open</Btn>,
          ])}
        />
      </Card>
    </div>
  );
};

// ── create company ──────────────────────────────────────────
const NewCompany = ({ onDone }: { onDone: () => void }) => {
  const [f, setF] = useState({ name: '', slug: '', adminName: '', adminEmail: '', timezone: 'Asia/Kolkata', defaultCurrency: 'INR', defaultCountry: '', morningReminderTime: '09:00', pipelinePreset: 'standard', teams: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [watching, setWatching] = useState<string | null>(null);
  const [run, setRun] = useState<Provisioning | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const health = useLoad(() => bee<PlatformHealth>('GET', '/v1/platform/health'));
  const set = (k: keyof typeof f, v: string) => setF((cur) => ({ ...cur, [k]: v, ...(k === 'name' && !slugTouched ? { slug: slugOf(v) } : {}) }));
  const teams = f.teams.split(',').map((t) => t.trim()).filter(Boolean).map((t) => ({ key: slugOf(t), name: t }));
  const valid = f.name.trim().length >= 2 && /^[a-z][a-z0-9-]{2,28}[a-z0-9]$/.test(f.slug) && f.adminName.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.adminEmail);

  // Creation runs in the background (a workspace takes about a minute); watch it until it is ready or has stopped.
  useEffect(() => {
    if (!watching) return undefined;
    const tick = async () => {
      try {
        const all = await bee<Provisioning[]>('GET', '/v1/platform/companies/in-progress');
        const mine = all.find((p) => p.slug === watching);
        if (mine) setRun(mine);
        if (mine && mine.state !== 'running') { if (timer.current) clearInterval(timer.current); setBusy(false); if (mine.state === 'failed') setErr(mine.error ?? 'Creation failed.'); }
      } catch { /* keep watching */ }
    };
    void tick();
    timer.current = setInterval(() => void tick(), 2500);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [watching]);

  const submit = async () => {
    setBusy(true); setErr(null); setRun(null);
    try {
      await bee('POST', '/v1/platform/companies', {
        name: f.name.trim(), slug: f.slug, adminName: f.adminName.trim(), adminEmail: f.adminEmail.trim(), timezone: f.timezone, defaultCurrency: f.defaultCurrency,
        ...(f.defaultCountry ? { defaultCountry: f.defaultCountry.toUpperCase() } : {}), morningReminderTime: f.morningReminderTime, pipelinePreset: f.pipelinePreset, teams,
      });
      setWatching(f.slug);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  const ok = run?.state === 'ready' ? run : null;
  if (ok) {
    return (
      <Card title="Company created">
        <Notice tone="ok">{ok.slug} is ready.</Notice>
        <Pairs rows={[
          ['Workspace', ok.workspaceUrl ?? '—'],
          ['Client admin', String(ok.request.adminEmail ?? '')],
          ['Invitation', ok.invitation?.sent ? <Badge tone="ok">e-mailed</Badge> : <span><Badge tone="warn">not sent</Badge> {ok.invitation?.error ?? ''}</span>],
          ['Steps', ok.steps.join(' → ')],
        ]} />
        <div style={C.muted}>The client admin opens the workspace address from the invitation, signs in, and manages users and teams under Bee › Users. Their data is isolated from every other company.</div>
        <Row><Btn kind="primary" onClick={onDone}>Back to companies</Btn></Row>
      </Card>
    );
  }
  return (
    <Card title="New company">
      {health.data && !health.data.companyCreation ? <Notice tone="error">Company creation is not configured on this deployment. Missing: {health.data.missing.join(', ')}.</Notice> : null}
      {err ? <Notice tone="error">{err}</Notice> : null}
      {run && run.state === 'running' ? <Notice tone="info">Creating {run.name ?? run.slug}… done so far: {run.steps.join(' → ') || 'starting'}</Notice> : null}
      <Pairs rows={[
        ['Company name', <TextInput value={f.name} onChange={(v) => set('name', v)} placeholder="Acme Foods" width={280} />],
        ['Address', <Row><TextInput value={f.slug} onChange={(v) => { setSlugTouched(true); set('slug', v.toLowerCase()); }} placeholder="acme-foods" width={200} /><span style={C.muted}>→ becomes the workspace address</span></Row>],
        ['Client admin name', <TextInput value={f.adminName} onChange={(v) => set('adminName', v)} placeholder="Priya Sharma" width={280} />],
        ['Client admin e-mail', <TextInput value={f.adminEmail} onChange={(v) => set('adminEmail', v)} placeholder="priya@acme.example" width={280} />],
        ['Time zone', <Select value={f.timezone} onChange={(v) => set('timezone', v)} options={ZONES} />],
        ['Currency · country', <Row><Select value={f.defaultCurrency} onChange={(v) => set('defaultCurrency', v)} options={CURRENCIES} /><TextInput value={f.defaultCountry} onChange={(v) => set('defaultCountry', v)} placeholder="IN" width={60} /></Row>],
        ['Morning reminder', <TextInput value={f.morningReminderTime} onChange={(v) => set('morningReminderTime', v)} width={80} />],
        ['Pipeline', <Select value={f.pipelinePreset} onChange={(v) => set('pipelinePreset', v)} options={[{ value: 'standard', label: 'Standard — New › Qualified › Meeting › Proposal › Negotiation › Won/Lost' }, { value: 'simple', label: 'Simple — Prospect › Discovery › Quote sent › Won/Lost' }]} />],
        ['Teams (optional)', <TextInput value={f.teams} onChange={(v) => set('teams', v)} placeholder="North, South" width={280} />],
      ]} />
      <div style={C.muted}>This creates the company's own Twenty workspace, installs Bee, applies the role model, and e-mails the first client admin. It takes up to a minute; if a step fails, submit again and it continues from where it stopped.</div>
      <Row>
        <Btn kind="primary" disabled={busy || !valid || (health.data ? !health.data.companyCreation : false)} onClick={() => void submit()}>{busy ? 'Creating… (workspace, Bee app, access, invitation)' : 'Create company'}</Btn>
        <Btn disabled={busy} onClick={onDone}>Cancel</Btn>
      </Row>
    </Card>
  );
};

// ── operators + activity ────────────────────────────────────
const Operators = () => {
  const ops = useLoad(() => bee<OperatorRow[]>('GET', '/v1/platform/operators'));
  const act = useAction();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [key, setKey] = useState<string | null>(null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {act.msg ? <Notice tone={act.msg.tone}>{act.msg.text}</Notice> : null}
      {key ? <Notice tone="info">API key for CLI/automation (shown once): <b>{key}</b></Notice> : null}
      <Card title="Add a platform operator">
        <Row>
          <TextInput value={name} onChange={setName} placeholder="Name" />
          <TextInput value={email} onChange={setEmail} placeholder="E-mail" width={240} />
          <Btn kind="primary" disabled={act.busy || name.trim().length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)} onClick={() => act.run(async () => {
            const r = await bee<{ apiKey: string; invitation: { sent: boolean; error?: string } }>('POST', '/v1/platform/operators', { name: name.trim(), email: email.trim() });
            setKey(r.apiKey); setName(''); setEmail(''); await ops.reload();
            if (!r.invitation.sent) throw new Error(`Operator added, but the invitation was not sent: ${r.invitation.error ?? 'unknown'}`);
          }, 'Operator added and invited to the operations workspace.')}>Add & invite</Btn>
        </Row>
        <div style={C.muted}>Operators run the service. They have no access to any company's CRM data unless a company admin approves a time-limited support request.</div>
      </Card>
      <Card title="Operators" actions={<Btn onClick={() => ops.reload()}>Refresh</Btn>}>
        {ops.error ? <Notice tone="error">{ops.error}</Notice> : null}
        <Table
          head={['Name', 'E-mail', 'Console access', 'Status', '']}
          empty="No operators."
          rows={(ops.data ?? []).map((o) => [o.name, o.email, o.signedIn ? <Badge tone="ok">signed up</Badge> : o.invited ? <Badge tone="accent">invited</Badge> : <Badge>—</Badge>, <Badge tone={o.status === 'active' ? 'ok' : 'danger'}>{o.status}</Badge>,
            o.status === 'active' ? <Btn kind="danger" disabled={act.busy} onClick={() => act.run(async () => { await bee('POST', `/v1/platform/operators/${o.id}/revoke`); await ops.reload(); }, 'Operator revoked.')}>Revoke</Btn> : null])}
        />
      </Card>
    </div>
  );
};

const Activity = () => {
  const a = useLoad(() => bee<PlatformAuditRow[]>('GET', '/v1/platform/audit?limit=100'));
  return (
    <Card title="Platform activity" actions={<Btn onClick={() => a.reload()}>Refresh</Btn>}>
      {a.error ? <Notice tone="error">{a.error}</Notice> : null}
      <Table head={['When', 'Operator', 'Action', 'Company / target', 'Result']} empty="Nothing yet." rows={(a.data ?? []).map((r) => [fmt(r.at), r.operator, <code>{r.action}</code>, r.target ?? '—', r.result])} />
    </Card>
  );
};

export const PlatformConsole = () => {
  const [tab, setTab] = useState<'companies' | 'new' | 'operators' | 'activity'>('companies');
  const [open, setOpen] = useState<string | null>(null);
  const tabs: Array<[typeof tab, string]> = [['companies', 'Companies'], ['new', 'New company'], ['operators', 'Operators'], ['activity', 'Activity']];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <nav style={{ display: 'flex', gap: 4, borderBottom: C.border }}>
        {tabs.map(([id, label]) => (
          <button key={id} type="button" onClick={() => { setTab(id); setOpen(null); }} style={{ padding: '6px 12px', border: 'none', borderBottom: tab === id ? `2px solid ${C.accent}` : '2px solid transparent', background: 'transparent', color: 'inherit', cursor: 'pointer', fontWeight: tab === id ? 600 : 400, fontSize: 13 }}>{label}</button>
        ))}
      </nav>
      {tab === 'companies' && (open ? <CompanyView id={open} onBack={() => setOpen(null)} /> : <Companies onOpen={setOpen} onNew={() => setTab('new')} />)}
      {tab === 'new' && <NewCompany onDone={() => setTab('companies')} />}
      {tab === 'operators' && <Operators />}
      {tab === 'activity' && <Activity />}
    </div>
  );
};
