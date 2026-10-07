import { useState } from 'react';
import { bee, type DirUser, type Member, type Team } from './api';
import { Badge, Btn, C, Card, Notice, Row, Select, Table, TextInput, useAction, useLoad } from './ui';

const ROLES = [
  { value: 'salesperson', label: 'Salesperson' },
  { value: 'manager', label: 'Manager' },
  { value: 'cxo', label: 'CXO' },
  { value: 'client_admin', label: 'Client admin' },
];
const roleLabel = (r: string) => ROLES.find((x) => x.value === r)?.label ?? r;

type Draft = { displayName: string; email: string; role: string; teamId: string; managed: string };
const empty: Draft = { displayName: '', email: '', role: 'salesperson', teamId: '', managed: '' };

export const Users = () => {
  const users = useLoad(() => bee<DirUser[]>('GET', '/v1/tenant-admin/users'));
  const members = useLoad(() => bee<Member[]>('GET', '/v1/tenant-admin/members'));
  const teams = useLoad(() => bee<Team[]>('GET', '/v1/tenant-admin/teams'));
  const act = useAction();
  const [form, setForm] = useState<Draft>(empty);
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft>(empty);
  const [code, setCode] = useState<{ user: string; code: string; expiresAt: string; channel: string } | null>(null);

  const teamOptions = [{ value: '', label: '— no team —' }, ...(teams.data ?? []).filter((t) => t.status === 'active').map((t) => ({ value: t.key, label: t.name }))];
  const reloadAll = async () => { await Promise.all([users.reload(), members.reload()]); };
  const managedList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const memberOf = (u: DirUser) => (members.data ?? []).find((m) => m.id === u.twentyMemberId);
  const linkable = (u: DirUser) => (members.data ?? []).filter((m) => !m.linkedUserId || m.linkedUserId === u.id);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {act.msg ? <Notice tone={act.msg.tone}>{act.msg.text}</Notice> : null}
      {code ? (
        <Notice tone="info">
          Enrollment code for {code.user} ({code.channel === 'whatsapp' ? 'WhatsApp' : 'Teams'}): <b style={{ fontSize: 16, letterSpacing: 1 }}>{code.code}</b> — shown once, valid until {new Date(code.expiresAt).toLocaleString()}. Give it to the employee through a company channel; they send it to the bot from their own account.
        </Notice>
      ) : null}

      <Card title="Add a user">
        <Row>
          <TextInput value={form.displayName} onChange={(v) => setForm({ ...form, displayName: v })} placeholder="Full name" />
          <TextInput value={form.email} onChange={(v) => setForm({ ...form, email: v })} placeholder="Work e-mail" width={220} />
          <Select value={form.role} onChange={(v) => setForm({ ...form, role: v })} options={ROLES} />
          <Select value={form.teamId} onChange={(v) => setForm({ ...form, teamId: v })} options={teamOptions} />
          {form.role === 'manager' ? <TextInput value={form.managed} onChange={(v) => setForm({ ...form, managed: v })} placeholder="Manages teams (keys, comma-separated)" width={240} /> : null}
          <Btn kind="primary" disabled={act.busy || !form.displayName || !form.email} onClick={() => act.run(async () => {
            await bee('POST', '/v1/tenant-admin/users', { displayName: form.displayName, email: form.email, role: form.role, teamId: form.teamId || null, ...(form.role === 'manager' ? { managedTeamIds: managedList(form.managed) } : {}) });
            setForm(empty); await reloadAll();
          }, 'User added. Invite them to this Twenty workspace, then link their Twenty account below.')}>Add</Btn>
        </Row>
        <div style={C.muted}>Salespeople and managers work through Ask AI › Bee, WhatsApp and Teams; Bee limits what they see. CXOs and client admins also get Twenty's own screens.</div>
      </Card>

      <Card title="Users" actions={<Btn onClick={() => reloadAll()}>Refresh</Btn>}>
        {users.error ? <Notice tone="error">{users.error}</Notice> : null}
        <Table
          head={['Name', 'Role', 'Team', 'Twenty account', 'Channels', 'Status', '']}
          empty="No users yet."
          rows={(users.data ?? []).map((u) => {
            const m = memberOf(u);
            const suggestion = !u.twentyMemberId ? (members.data ?? []).find((x) => x.suggestedUserId === u.id) : undefined;
            if (editing === u.id) {
              return [
                <TextInput value={edit.displayName} onChange={(v) => setEdit({ ...edit, displayName: v })} />,
                <Select value={edit.role} onChange={(v) => setEdit({ ...edit, role: v })} options={ROLES} />,
                <Select value={edit.teamId} onChange={(v) => setEdit({ ...edit, teamId: v })} options={teamOptions} />,
                edit.role === 'manager' ? <TextInput value={edit.managed} onChange={(v) => setEdit({ ...edit, managed: v })} placeholder="Manages (keys)" /> : <span style={C.muted}>—</span>,
                '', '',
                <span style={{ display: 'flex', gap: 6 }}>
                  <Btn kind="primary" disabled={act.busy} onClick={() => act.run(async () => {
                    await bee('PATCH', `/v1/tenant-admin/users/${u.id}`, { displayName: edit.displayName, role: edit.role, teamId: edit.teamId || null, ...(edit.role === 'manager' ? { managedTeamIds: managedList(edit.managed) } : {}) });
                    setEditing(null); await reloadAll();
                  }, 'Saved. Pending drafts were reset and Twenty access was updated.')}>Save</Btn>
                  <Btn onClick={() => setEditing(null)}>Cancel</Btn>
                </span>,
              ];
            }
            return [
              <span>{u.displayName}<div style={C.muted}>{u.email}</div></span>,
              <Badge tone={u.role === 'client_admin' ? 'accent' : 'muted'}>{roleLabel(u.role)}</Badge>,
              <span>{u.teamId ?? '—'}{u.managedTeamIds.length ? <div style={C.muted}>manages {u.managedTeamIds.join(', ')}</div> : null}</span>,
              m ? <span>{m.email ?? m.name} <Btn disabled={act.busy} onClick={() => act.run(async () => { await bee('POST', `/v1/tenant-admin/users/${u.id}/unlink`); await reloadAll(); }, 'Unlinked; their in-CRM access stopped.')}>Unlink</Btn></span>
                : (
                  <Select value="" onChange={(memberId) => memberId && act.run(async () => { await bee('POST', `/v1/tenant-admin/users/${u.id}/link`, { memberId }); await reloadAll(); }, 'Linked to their Twenty account.')}
                    options={[{ value: '', label: suggestion ? `Link… (suggested: ${suggestion.email})` : 'Link a Twenty member…' }, ...linkable(u).map((x) => ({ value: x.id, label: `${x.name}${x.email ? ` <${x.email}>` : ''}` }))]} />
                ),
              <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {u.channels.filter((c) => c.status === 'active').map((c) => <Badge key={c.channel} tone="ok">{c.channel}</Badge>)}
                {u.status === 'active' ? ['whatsapp', 'teams'].map((ch) => (
                  <Btn key={ch} disabled={act.busy} onClick={() => act.run(async () => {
                    const r = await bee<{ code: string; expiresAt: string }>('POST', `/v1/tenant-admin/users/${u.id}/enrollment`, { channel: ch });
                    setCode({ user: u.displayName, code: r.code, expiresAt: r.expiresAt, channel: ch });
                  })}>+ {ch === 'whatsapp' ? 'WhatsApp' : 'Teams'}</Btn>
                )) : null}
              </span>,
              <Badge tone={u.status === 'active' ? 'ok' : 'danger'}>{u.status}</Badge>,
              <span style={{ display: 'flex', gap: 6 }}>
                <Btn onClick={() => { setEditing(u.id); setEdit({ displayName: u.displayName, email: u.email ?? '', role: u.role, teamId: u.teamId ?? '', managed: u.managedTeamIds.join(', ') }); }}>Edit</Btn>
                {u.status === 'active'
                  ? <Btn kind="danger" disabled={act.busy} onClick={() => act.run(async () => { await bee('POST', `/v1/tenant-admin/users/${u.id}/revoke`); await reloadAll(); }, `${u.displayName} revoked: chat, drafts and reminders stopped; Twenty access removed.`)}>Revoke</Btn>
                  : <Btn disabled={act.busy} onClick={() => act.run(async () => { await bee('POST', `/v1/tenant-admin/users/${u.id}/reinstate`); await reloadAll(); }, 'Reinstated. Channels must be enrolled again.')}>Reinstate</Btn>}
              </span>,
            ];
          })}
        />
      </Card>

      <Card title="Twenty members without a Bee user">
        <Table
          head={['Member', 'E-mail']}
          empty="Every Twenty member is linked to a Bee user."
          rows={(members.data ?? []).filter((m) => !m.linkedUserId).map((m) => [m.name, m.email ?? '—'])}
        />
        <div style={C.muted}>Unlinked members get no access in Twenty until you add them as users and link them.</div>
      </Card>
    </div>
  );
};
