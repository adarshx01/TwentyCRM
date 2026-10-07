import { bee, type ArchiveReq, type IntakeItem, type Permission } from './api';
import { Badge, Btn, Card, Notice, Table, fmt, useAction, useLoad } from './ui';

export const Approvals = ({ permissions }: { permissions: Permission[] }) => {
  const canArchive = permissions.includes('approvals.decide');
  const canIntake = permissions.includes('intake.review');
  const archive = useLoad(() => (canArchive ? bee<ArchiveReq[]>('GET', '/v1/approvals/archive') : Promise.resolve([])));
  const intake = useLoad(() => (canIntake ? bee<IntakeItem[]>('GET', '/v1/approvals/intake') : Promise.resolve([])));
  const act = useAction();
  const decide = (kind: 'archive' | 'intake', id: string, d: 'approve' | 'reject', ok: string) =>
    act.run(async () => { await bee('POST', `/v1/approvals/${kind}/${id}/${d}`, {}); await (kind === 'archive' ? archive : intake).reload(); }, ok);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {act.msg ? <Notice tone={act.msg.tone}>{act.msg.text}</Notice> : null}
      {canArchive ? (
        <Card title="Archive requests" actions={<Btn onClick={() => archive.reload()}>Refresh</Btn>}>
          {archive.error ? <Notice tone="error">{archive.error}</Notice> : null}
          <Table
            head={['Record', 'Requested by', 'When', 'Reason', '']}
            empty="Nothing waiting for you. Only requests for records in your scope appear here."
            rows={(archive.data ?? []).map((r) => [
              <span>{r.targetLabel} <Badge>{r.targetType}</Badge></span>, r.requestedBy ?? '—', fmt(r.requestedAt), r.reason ?? '—',
              <span style={{ display: 'flex', gap: 6 }}>
                <Btn kind="primary" disabled={act.busy} onClick={() => decide('archive', r.id, 'approve', `Archiving ${r.targetLabel} (recoverable).`)}>Approve</Btn>
                <Btn disabled={act.busy} onClick={() => decide('archive', r.id, 'reject', 'Request rejected.')}>Reject</Btn>
              </span>,
            ])}
          />
        </Card>
      ) : null}
      {canIntake ? (
        <Card title="Website enquiries to review" actions={<Btn onClick={() => intake.reload()}>Refresh</Btn>}>
          {intake.error ? <Notice tone="error">{intake.error}</Notice> : null}
          <Table
            head={['Visitor', 'Company', 'E-mail', 'Why review', 'Received', '']}
            empty="No enquiries waiting. Managers see enquiries routed to their teams; others go to administrators."
            rows={(intake.data ?? []).map((r) => [
              String(r.fields.name ?? '—'), String(r.fields.company ?? '—'), String(r.fields.email ?? '—'), r.reason ?? '—', fmt(r.receivedAt),
              <span style={{ display: 'flex', gap: 6 }}>
                <Btn kind="primary" disabled={act.busy} onClick={() => decide('intake', r.id, 'approve', 'Saved to the CRM.')}>Approve</Btn>
                <Btn disabled={act.busy} onClick={() => decide('intake', r.id, 'reject', 'Rejected; no opportunity created.')}>Reject</Btn>
              </span>,
            ])}
          />
        </Card>
      ) : null}
    </div>
  );
};
