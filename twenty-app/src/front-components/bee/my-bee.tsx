import { bee, type ArchiveReq, type Me } from './api';
import { Badge, Btn, C, Card, Notice, Pairs, Table, fmt, useAction, useLoad } from './ui';

const SCOPE_TEXT = { own: 'records you own or are assigned', team: 'your records and those of the teams you manage', all: 'every record of the company' } as const;

export const MyBee = ({ me }: { me: Extract<Me, { linked: true }> }) => {
  const reqs = useLoad(() => bee<ArchiveReq[]>('GET', '/v1/me/archive-requests'));
  const act = useAction();
  const u = me.user;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
