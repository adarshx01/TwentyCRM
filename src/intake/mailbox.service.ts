import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../database/db.service';
import { intakeSources, mailboxCheckpoints } from '../database/schema';
import { SECRET_RESOLVER, type SecretResolver } from '../secrets/secret-resolver';
import { FETCH_FN } from '../crm/twenty/twenty-client';
import { IntakeService } from './intake.service';
import { M } from '../observability/metrics';
import { getLogger } from '../observability/logger';
import { errorMessage } from '../common/errors';

export interface MailboxMessage { id: string; internetMessageId: string; receivedAt: string; raw: Buffer }

export interface MailboxProvider {
  /** Messages received at/after `since`, oldest first. Read-only: never deletes or moves mail (Section 18). */
  list(mailbox: { mailboxId: string; folderId?: string }, token: string, since: Date | null, limit: number): Promise<MailboxMessage[]>;
}
export const MAILBOX_PROVIDER = 'MAILBOX_PROVIDER';

export class MailboxAuthError extends Error {}

/** Microsoft Graph mailbox reader with the minimum scope (Mail.ReadBasic is not enough; Mail.Read on one mailbox). */
@Injectable()
export class GraphMailboxProvider implements MailboxProvider {
  constructor(@Inject(FETCH_FN) private readonly fetchFn: typeof fetch) {}

  async list(mb: { mailboxId: string; folderId?: string }, token: string, since: Date | null, limit: number): Promise<MailboxMessage[]> {
    const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mb.mailboxId)}${mb.folderId ? `/mailFolders/${encodeURIComponent(mb.folderId)}` : ''}/messages`;
    const filter = since ? `&$filter=receivedDateTime ge ${since.toISOString()}` : '';
    const res = await this.fetchFn(`${base}?$select=id,internetMessageId,receivedDateTime&$orderby=receivedDateTime asc&$top=${limit}${filter}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 401 || res.status === 403) throw new MailboxAuthError(`mailbox access refused (${res.status})`);
    if (!res.ok) throw new Error(`Graph returned ${res.status}`);
    const json: any = await res.json();
    const out: MailboxMessage[] = [];
    for (const m of json.value ?? []) {
      const rawRes = await this.fetchFn(`${base}/${encodeURIComponent(m.id)}/$value`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
      if (!rawRes.ok) throw new Error(`Graph returned ${rawRes.status} for message body`);
      out.push({ id: m.id, internetMessageId: m.internetMessageId ?? m.id, receivedAt: m.receivedDateTime, raw: Buffer.from(await rawRes.arrayBuffer()) });
    }
    return out;
  }
}

const OVERLAP_MS = 10 * 60_000;

/**
 * Durable-checkpoint mailbox polling (IN-02, AT-22). Each poll re-reads from
 * checkpoint − overlap; duplicates are suppressed by the delivery key (Message-ID), so
 * replay is idempotent. The checkpoint only advances after every message in the batch was
 * durably recorded, so an outage or expired token never loses mail.
 */
@Injectable()
export class MailboxPoller {
  private readonly log = getLogger('mailbox');

  constructor(
    private readonly db: DbService,
    private readonly intake: IntakeService,
    @Inject(SECRET_RESOLVER) private readonly secrets: SecretResolver,
    @Inject(MAILBOX_PROVIDER) private readonly provider: MailboxProvider,
  ) {}

  async pollAll(): Promise<number> {
    const sources = await this.db.systemTx((tx) => tx.select().from(intakeSources).where(eq(intakeSources.type, 'mailbox_poll')));
    return sources.filter((s) => s.status === 'active' && s.mailbox).length;
  }

  async poll(sourceUuid: string, batch = 50): Promise<{ accepted: number; duplicates: number }> {
    const [src] = await this.db.systemTx((tx) => tx.select().from(intakeSources).where(eq(intakeSources.id, sourceUuid)));
    if (!src || src.status !== 'active' || !src.mailbox) return { accepted: 0, duplicates: 0 };
    const [cp] = await this.db.tenantTx(src.tenantId, (tx) => tx.select().from(mailboxCheckpoints).where(eq(mailboxCheckpoints.sourceId, src.id)));
    const since = cp?.checkpoint ? new Date(cp.checkpoint.getTime() - OVERLAP_MS) : null;
    const save = (patch: Partial<typeof mailboxCheckpoints.$inferInsert>) => this.db.tenantTx(src.tenantId, (tx) =>
      tx.insert(mailboxCheckpoints).values({ sourceId: src.id, tenantId: src.tenantId, ...patch }).onConflictDoUpdate({ target: mailboxCheckpoints.sourceId, set: { ...patch, updatedAt: new Date() } }));
    let accepted = 0; let duplicates = 0;
    try {
      const token = await this.secrets.resolve(src.mailbox.tokenRef);
      const msgs = await this.provider.list(src.mailbox, token, since, batch);
      let newest = cp?.checkpoint ?? null;
      for (const m of msgs) {
        const r = await this.intake.receiveFromMailbox(src, m.internetMessageId, m.raw, m.receivedAt);
        if (r.status === 'accepted') accepted++; else duplicates++;
        const t = new Date(m.receivedAt);
        if (!newest || t > newest) newest = t;
      }
      await save({ checkpoint: newest, health: 'ok', lastError: null, lastPolledAt: new Date() });
      M.channelHealth().set({ channel: `mailbox:${src.sourceId}` }, 1);
    } catch (e) {
      // Do not advance the checkpoint; surface health so operators are alerted (AT-22).
      const health = e instanceof MailboxAuthError ? 'token_expired' : 'error';
      await save({ health, lastError: errorMessage(e).slice(0, 300), lastPolledAt: new Date() });
      M.channelHealth().set({ channel: `mailbox:${src.sourceId}` }, 0);
      this.log.error({ sourceId: src.sourceId, health }, 'mailbox poll failed');
      throw e;
    }
    return { accepted, duplicates };
  }
}
