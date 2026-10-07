import { useEffect, useState } from 'react';
import { bee, type AccessReport, type AuditEntry, type Config, type Grant, type Team } from './api';
import { Badge, Btn, C, Card, Notice, Pairs, Row, Table, TextInput, fmt, useAction, useLoad } from './ui';

export const Teams = () => {
  const teams = useLoad(() => bee<Team[]>('GET', '/v1/tenant-admin/teams'));
  const act = useAction();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  return (
    <Card title="Teams" actions={<Btn onClick={() => teams.reload()}>Refresh</Btn>}>
      {act.msg ? <Notice tone={act.msg.tone}>{act.msg.text}</Notice> : null}
      <Row>
        <TextInput value={key} onChange={(v) => setKey(v.toLowerCase())} placeholder="key (e.g. north)" width={140} />
        <TextInput value={name} onChange={setName} placeholder="Name" />
        <Btn kind="primary" disabled={act.busy || !key || !name} onClick={() => act.run(async () => { await bee('POST', '/v1/tenant-admin/teams', { key, name }); setKey(''); setName(''); await teams.reload(); }, 'Team saved.')}>Save team</Btn>
      </Row>
      <Table
        head={['Team', 'Key', 'Members', 'Managers', 'Status', '']}
        empty="No teams yet. Managers see the records of the teams assigned to them."
        rows={(teams.data ?? []).map((t) => [
          t.name, <code>{t.key}</code>, t.members, t.managers, <Badge tone={t.status === 'active' ? 'ok' : 'muted'}>{t.status}</Badge>,
          t.status === 'active' ? <Btn disabled={act.busy} onClick={() => act.run(async () => { await bee('POST', `/v1/tenant-admin/teams/${t.key}/deactivate`); await teams.reload(); }, 'Team deactivated.')}>Deactivate</Btn> : null,
        ])}
      />
    </Card>
  );
};

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const Settings = () => {
  const cfg = useLoad(() => bee<Config>('GET', '/v1/tenant-admin/config'));
  const access = useLoad(() => bee<AccessReport>('GET', '/v1/tenant-admin/access'));
  const act = useAction();
  const [draft, setDraft] = useState<Config | null>(null);
  useEffect(() => { if (cfg.data) setDraft(cfg.data); }, [cfg.data]);
  if (!draft) return <Card title="Settings">{cfg.error ? <Notice tone="error">{cfg.error}</Notice> : <div style={C.muted}>Loading…</div>}</Card>;
  const save = () => act.run(async () => {
    await bee('PATCH', '/v1/tenant-admin/config', { timezone: draft.timezone, workingDays: draft.workingDays, morningReminderTime: draft.morningReminderTime, defaultCurrency: draft.defaultCurrency, pipeline: { defaultInitialStage: draft.pipeline.defaultInitialStage, stages: draft.pipeline.stages } });
    await cfg.reload();
  }, 'Saved as a new configuration version.');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {act.msg ? <Notice tone={act.msg.tone}>{act.msg.text}</Notice> : null}
      <Card title={`Workspace settings · version ${draft.configVersion}`} actions={<Btn kind="primary" disabled={act.busy} onClick={save}>Save</Btn>}>
        <Pairs rows={[
          ['Time zone', <TextInput value={draft.timezone} onChange={(v) => setDraft({ ...draft, timezone: v })} />],
          ['Morning reminder', <TextInput value={draft.morningReminderTime} onChange={(v) => setDraft({ ...draft, morningReminderTime: v })} width={80} />],
          ['Working days', <Row gap={4}>{DAYS.map((d, i) => { const n = i + 1; const on = draft.workingDays.includes(n); return <Btn key={d} kind={on ? 'primary' : 'default'} onClick={() => setDraft({ ...draft, workingDays: on ? draft.workingDays.filter((x) => x !== n) : [...draft.workingDays, n].sort() })}>{d}</Btn>; })}</Row>],
          ['Currency', <TextInput value={draft.defaultCurrency} onChange={(v) => setDraft({ ...draft, defaultCurrency: v.toUpperCase() })} width={70} />],
        ]} />
      </Card>
      <Card title="Pipeline stages">
        <div style={C.muted}>Labels can change freely; stage ids stay stable. Removing a stage that still has deals needs a migration preview (ask your YlogX operator).</div>
        <Table
          head={['Stage id', 'Label', 'Outcome']}
          empty="No stages."
          rows={draft.pipeline.stages.map((s, i) => [
            <code>{s.id}</code>,
            <TextInput value={s.label} onChange={(v) => setDraft({ ...draft, pipeline: { ...draft.pipeline, stages: draft.pipeline.stages.map((x, j) => (j === i ? { ...x, label: v } : x)) } })} />,
            s.terminal ? <Badge tone={s.terminal === 'won' ? 'ok' : 'danger'}>{s.terminal}</Badge> : '—',
          ])}
        />
      </Card>
      <Card title="Twenty access" actions={<Btn disabled={act.busy} onClick={() => act.run(async () => { await bee('POST', '/v1/tenant-admin/access/sync'); await access.reload(); }, 'Twenty roles brought in line with Bee.')}>Apply now</Btn>}>
        <div style={C.muted}>Bee keeps Twenty's own roles in line with the roles above (checked every few minutes). Changes made directly in Twenty are reverted and listed here.</div>
        {access.error ? <Notice tone="error">{access.error}</Notice> : null}
        {access.data ? (
          access.data.ok ? (
            <Pairs rows={[
              ['Status', access.data.memberChanges.length || access.data.rolesCreated.length || access.data.workspaceSettingsChanged.length ? <Badge tone="warn">changes pending</Badge> : <Badge tone="ok">in line with Bee</Badge>],
              ['Pending member changes', access.data.memberChanges.length ? access.data.memberChanges.map((m) => `${m.email ?? 'member'}: ${m.from ?? '—'} → ${m.to}`).join('; ') : '—'],
              ['Notes', access.data.drift.length ? access.data.drift.join('; ') : '—'],
            ]} />
          ) : <Notice tone="error">Could not read Twenty access: {access.data.error}</Notice>
        ) : null}
      </Card>
    </div>
  );
};

export const Security = () => {
  const grants = useLoad(() => bee<Grant[]>('GET', '/v1/tenant-admin/support'));
  const audit = useLoad(() => bee<AuditEntry[]>('GET', '/v1/tenant-admin/audit?limit=100'));
  const act = useAction();
  const decide = (id: string, d: 'approve' | 'deny' | 'revoke', ok: string) => act.run(async () => { await bee('POST', `/v1/tenant-admin/support/${id}/${d}`); await Promise.all([grants.reload(), audit.reload()]); }, ok);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {act.msg ? <Notice tone={act.msg.tone}>{act.msg.text}</Notice> : null}
      <Card title="YlogX support access" actions={<Btn onClick={() => grants.reload()}>Refresh</Btn>}>
        <div style={C.muted}>YlogX operators cannot see your CRM data unless you approve a time-limited request here. Every access is recorded in the audit trail below.</div>
        <Table
          head={['Operator', 'Reason', 'Duration', 'Status', '']}
          empty="No support requests."
          rows={(grants.data ?? []).map((g) => [
            g.operator ? `${g.operator.name} <${g.operator.email}>` : '—', g.reason, `${g.hours} h`,
            <Badge tone={g.effectiveState === 'active' ? 'warn' : g.effectiveState === 'requested' ? 'accent' : 'muted'}>{g.effectiveState}{g.effectiveState === 'active' && g.expiresAt ? ` until ${fmt(g.expiresAt)}` : ''}</Badge>,
            g.effectiveState === 'requested' ? <span style={{ display: 'flex', gap: 6 }}><Btn kind="primary" disabled={act.busy} onClick={() => decide(g.id, 'approve', 'Access granted for a limited time.')}>Approve</Btn><Btn disabled={act.busy} onClick={() => decide(g.id, 'deny', 'Request denied.')}>Deny</Btn></span>
              : g.effectiveState === 'active' ? <Btn kind="danger" disabled={act.busy} onClick={() => decide(g.id, 'revoke', 'Access ended.')}>End access</Btn> : null,
          ])}
        />
      </Card>
      <Card title="Audit trail" actions={<Btn onClick={() => audit.reload()}>Refresh</Btn>}>
        {audit.error ? <Notice tone="error">{audit.error}</Notice> : null}
        <Table
          head={['When', 'Who', 'What', 'About', 'Result']}
          empty="No audit entries yet."
          rows={(audit.data ?? []).map((e) => [fmt(e.at), e.actor, <code>{e.action}</code>, e.subject ?? e.resourceType ?? '—', e.result ?? '—'])}
        />
      </Card>
    </div>
  );
};
