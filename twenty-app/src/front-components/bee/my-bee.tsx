import { useState } from 'react';
import { bee, type ArchiveReq, type Me, type OpenDraft, type OperationView } from './api';
import { Badge, Btn, C, Card, Notice, Pairs, Table, fmt, useAction, useLoad } from './ui';

const SCOPE_TEXT = { own: 'records you own or are assigned', team: 'your records and those of the teams you manage', all: 'every record of the company' } as const;

const Drafts = () => {
  const drafts = useLoad(() => bee<OpenDraft[]>('GET', '/v1/me/drafts'));
  const act = useAction();
  const [done, setDone] = useState<OperationView | null>(null);

  const follow = async (operationId: string) => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const op = await bee<OperationView>('GET', `/v1/me/operations/${operationId}`);
      if (['committed', 'failed', 'needs_repair'].includes(op.state)) { setDone(op); return; }
    }
  };
  const confirm = (d: OpenDraft) => act.run(async () => {
    const r = await bee<{ status: string; operationId?: string; message?: string }>('POST', `/v1/me/drafts/${d.id}/confirm`, { version: d.version, hash: d.hash });
    if (r.status === 'committing' || r.status === 'already_confirmed') { await drafts.reload(); if (r.operationId) await follow(r.operationId); return; }
    throw new Error(r.message ?? `Could not confirm (${r.status}).`);
  });
  return (
    <Card title="Waiting for your confirmation" actions={<Btn onClick={() => drafts.reload()}>Refresh</Btn>}>
      {drafts.error ? <Notice tone="error">{drafts.error}</Notice> : null}
      {act.msg ? <Notice tone={act.msg.tone}>{act.msg.text}</Notice> : null}
      {done ? (
        <Notice tone={done.state === 'committed' ? 'ok' : 'error'}>
          {done.state === 'committed'
            ? <span>Saved ({done.reference}). {done.refs.map((r) => <span key={r.label}><br />{r.label}{r.url ? ` — ${r.url}` : ''}</span>)}</span>
            : <span>{done.error ?? 'Part of this could not be completed.'} Saved: {done.saved.join(', ') || 'nothing'}. Needs attention: {[...done.failed, ...done.pending].join(', ')}.</span>}
        </Notice>
      ) : null}
      {(drafts.data ?? []).length === 0 ? <div style={C.muted}>Nothing is waiting. Drafts you start in Ask AI, WhatsApp or Teams appear here until you confirm or cancel them.</div> : null}
      {(drafts.data ?? []).map((d) => (
        <div key={d.id} style={{ border: C.border, borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5 }}>{d.text}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn kind="primary" disabled={act.busy} onClick={() => confirm(d)}>Confirm</Btn>
            <Btn kind="danger" disabled={act.busy} onClick={() => act.run(async () => { await bee('POST', `/v1/me/drafts/${d.id}/cancel`); await drafts.reload(); }, 'Draft cancelled. Nothing was saved.')}>Cancel</Btn>
          </div>
        </div>
      ))}
      <div style={C.muted}>To change a draft, reply to it in the chat where you started it (for example “phone: +91…”).</div>
    </Card>
  );
};

export const MyBee = ({ me }: { me: Extract<Me, { linked: true }> }) => {
  const reqs = useLoad(() => bee<ArchiveReq[]>('GET', '/v1/me/archive-requests'));
  const act = useAction();
  const u = me.user;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Drafts />
      <Card title="Your Bee access">
        <Pairs rows={[
          ['Name', u.displayName],
          ['Role', <Badge tone="accent">{u.roleLabel}</Badge>],
          ['Bee shows you', SCOPE_TEXT[me.scope]],
          ['Team', u.teamId ?? '—'],
          ...(u.managedTeamIds.length ? [['Teams you manage', u.managedTeamIds.join(', ')] as [string, string]] : []),
          ['Morning reminder', `${u.morningReminderTime} (${u.timezone})`],
        ]} />
        <div style={C.muted}>Your role and teams are managed by your company's Bee administrator.</div>
      </Card>
      <Card title="Where you can use Bee">
        <Pairs rows={[
          ['Inside Twenty', 'Ask AI › mention Bee, e.g. “Create a new lead: Rajesh Kumar, ABC Industries”'],
          ...['whatsapp', 'teams'].map((ch) => {
            const b = u.channels.find((x) => x.channel === ch && x.status === 'active');
            return [ch === 'whatsapp' ? 'WhatsApp' : 'Microsoft Teams', b ? <Badge tone="ok">connected</Badge> : <span style={C.muted}>not connected — ask your administrator for an enrollment code</span>] as [string, unknown];
          }) as Array<[string, any]>,
        ]} />
      </Card>
      <Card title="Your archive requests">
        {reqs.error ? <Notice tone="error">{reqs.error}</Notice> : null}
        {act.msg ? <Notice tone={act.msg.tone}>{act.msg.text}</Notice> : null}
        <Table
          head={['Record', 'Requested', 'Status', '']}
          empty="You have not requested any archives. Ask Bee to “archive” a lead and an approver will decide."
          rows={(reqs.data ?? []).map((r) => [
            r.targetLabel, fmt(r.requestedAt),
            <Badge tone={r.state === 'approved' ? 'ok' : r.state === 'rejected' ? 'danger' : 'muted'}>{r.state}{r.decidedBy ? ` by ${r.decidedBy}` : ''}</Badge>,
            r.state === 'pending' ? <Btn disabled={act.busy} onClick={() => act.run(async () => { await bee('POST', `/v1/me/archive-requests/${r.id}/cancel`); await reqs.reload(); }, 'Request withdrawn.')}>Withdraw</Btn> : null,
          ])}
        />
      </Card>
    </div>
  );
};
