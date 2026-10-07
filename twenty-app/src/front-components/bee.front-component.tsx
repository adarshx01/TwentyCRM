import { useState } from 'react';
import { defineFrontComponent } from 'twenty-sdk/define';

import { FC_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { bee, type Me } from './bee/api';
import { Approvals } from './bee/approvals';
import { Security, Settings, Teams } from './bee/admin-other';
import { MyBee } from './bee/my-bee';
import { Users } from './bee/users';
import { C, Notice, useLoad } from './bee/ui';

type Tab = { id: string; label: string; show: boolean; render: () => JSX.Element };

/**
 * Bee inside Twenty: every employee's own access, approvals for approvers, and administration for client admins.
 * Tabs follow the permissions Bee reports for the signed-in member; Bee enforces every action server-side regardless.
 */
const BeePage = () => {
  const me = useLoad(() => bee<Me>('GET', '/v1/me'));
  const [tab, setTab] = useState('me');

  if (me.loading && !me.data) return <main style={{ padding: 24 }}><div style={C.muted}>Loading Bee…</div></main>;
  if (me.error) return <main style={{ padding: 24 }}><Notice tone="error">{me.error}</Notice></main>;
  const m = me.data!;
  if (!m.linked) {
    return (
      <main style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 16 }}>Bee</div>
        <Notice tone="info">{m.message}</Notice>
      </main>
    );
  }
  const p = new Set(m.permissions);
  const tabs: Tab[] = [
    { id: 'me', label: 'My Bee', show: true, render: () => <MyBee me={m} /> },
    { id: 'approvals', label: 'Approvals', show: p.has('approvals.decide') || p.has('intake.review'), render: () => <Approvals permissions={m.permissions} /> },
    { id: 'users', label: 'Users', show: p.has('tenant.users.manage'), render: () => <Users /> },
    { id: 'teams', label: 'Teams', show: p.has('tenant.teams.manage'), render: () => <Teams /> },
    { id: 'settings', label: 'Settings', show: p.has('tenant.config.manage'), render: () => <Settings /> },
    { id: 'security', label: 'Security & audit', show: p.has('tenant.audit.read') || p.has('tenant.support.approve'), render: () => <Security /> },
  ].filter((t) => t.show);
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];

  return (
    <main style={{ boxSizing: 'border-box', display: 'grid', gridTemplateRows: 'auto minmax(0,1fr)', height: '100%', width: '100%', overflow: 'hidden' }}>
      <header style={{ padding: '12px 16px 0', borderBottom: C.border }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div style={{ fontWeight: 600 }}>Bee</div>
          <div style={C.muted}>{m.user.displayName} · {m.user.roleLabel}</div>
        </div>
        <nav style={{ display: 'flex', gap: 4, marginTop: 10 }}>
          {tabs.map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} style={{ padding: '6px 12px', border: 'none', borderBottom: t.id === current.id ? `2px solid ${C.accent}` : '2px solid transparent', background: 'transparent', color: 'inherit', cursor: 'pointer', fontWeight: t.id === current.id ? 600 : 400, fontSize: 13 }}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <section style={{ overflowY: 'auto', padding: 16 }}>{current.render()}</section>
    </main>
  );
};

export default defineFrontComponent({
  universalIdentifier: FC_UNIVERSAL_IDENTIFIER,
  name: 'bee',
  description: 'Bee: your access, approvals and (for client admins) user, team and workspace administration.',
  component: BeePage,
});
