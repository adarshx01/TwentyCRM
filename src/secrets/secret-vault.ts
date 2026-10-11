import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { DbService } from '../database/db.service';
import { secretVault } from '../database/schema';

/**
 * Credentials Bee creates for itself when it provisions a company (the workspace's integration key, the service
 * user's password). AES-256-GCM with a key derived from SECRETS_MASTER_KEY; the database holds ciphertext only and
 * the table is readable solely inside a system transaction. Manifests and tenant rows keep the reference `db:<name>`
 * (CFG-03: references, never values).
 */
@Injectable()
export class SecretVault {
  constructor(private readonly db: DbService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private key(): Buffer {
    const master = this.config.security.secretsMasterKey;
    if (!master) throw new Error('SECRETS_MASTER_KEY is not configured: Bee cannot store provisioned credentials.');
    return createHash('sha256').update(`crm-bee-vault:v1:${master}`).digest();
  }

  async put(name: string, value: string): Promise<string> {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key(), iv);
    const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    const blob = Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    await this.db.systemTx((tx) => tx.insert(secretVault).values({ name, ciphertext: blob }).onConflictDoUpdate({ target: secretVault.name, set: { ciphertext: blob, updatedAt: new Date() } }));
    return `db:${name}`;
  }

  async get(name: string): Promise<string | null> {
    const [row] = await this.db.systemTx((tx) => tx.select().from(secretVault).where(eq(secretVault.name, name)));
    if (!row) return null;
    const raw = Buffer.from(row.ciphertext, 'base64');
    const d = createDecipheriv('aes-256-gcm', this.key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }

  async has(name: string): Promise<boolean> {
    return (await this.get(name).catch(() => null)) !== null;
  }
}
