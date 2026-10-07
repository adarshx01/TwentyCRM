import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, isNull, isNotNull, lt, or, eq, inArray } from 'drizzle-orm';
import { parseBuffer } from 'music-metadata';
import { DbService } from '../database/db.service';
import { drafts, mediaObjects, type MediaRef } from '../database/schema';
import { STORAGE, type StorageProvider } from './storage';
import { SCANNER, type Scanner } from './scanner';
import { AUDIO_TYPES, EXTENSION, IMAGE_TYPES, detectMime } from './mime';
import { UserFacingError } from '../common/errors';
import { MAX_AUDIO_DURATION_SECONDS, MAX_AUDIO_SIZE, MAX_IMAGE_SIZE } from '../common/utils/sanitize.util';
import { getLogger } from '../observability/logger';
import { M } from '../observability/metrics';

export interface IngestInput {
  tenantId: string;
  data: Buffer;
  declaredMime?: string;
  kind: 'card' | 'voice' | 'raw_email';
  draftId?: string;
}

/**
 * Secure media handling (CAP-01, SEC-01, SEC-04).
 * Validates real content type and size, scans, stores under a tenant-prefixed key,
 * never exposes public URLs, and applies retention (abandoned 24h, confirmed 30d).
 */
@Injectable()
export class MediaService {
  private readonly log = getLogger('media');

  constructor(
    private readonly db: DbService,
    @Inject(STORAGE) private readonly storage: StorageProvider,
    @Inject(SCANNER) private readonly scanner: Scanner,
  ) {}

  static keyPrefix(tenantId: string): string { return `tenants/${tenantId}/`; }

  async ingest(input: IngestInput): Promise<MediaRef> {
    const { data, kind, tenantId } = input;
    if (kind === 'raw_email') return this.store(tenantId, data, 'message/rfc822', kind, input.draftId, 'eml');

    const detected = detectMime(data);
    if (!detected) throw new UserFacingError('I could not read that file. Please send a JPEG or PNG card photo, or a supported audio file.', 'MEDIA_TYPE');
    if (kind === 'card') {
      if (!IMAGE_TYPES.has(detected)) throw new UserFacingError('Business cards must be JPEG or PNG images.', 'MEDIA_TYPE');
      if (data.length > MAX_IMAGE_SIZE) throw new UserFacingError('That image is larger than 10 MB. Please send a smaller photo.', 'MEDIA_SIZE');
    } else {
      if (!AUDIO_TYPES.has(detected)) throw new UserFacingError('That audio format is not supported. Please send an OGG, MP3, M4A, WAV or WebM voice note.', 'MEDIA_TYPE');
      if (data.length > MAX_AUDIO_SIZE) throw new UserFacingError('That audio file is larger than 20 MB.', 'MEDIA_SIZE');
      // Corrupt files and over-long recordings are rejected with a useful message (CAP-01).
      try {
        const meta = await parseBuffer(data, { mimeType: detected }, { duration: true });
        // No readable duration means the container is truncated or not really audio.
        if (!meta.format.duration || meta.format.duration <= 0) throw new Error('unreadable audio');
        if (meta.format.duration > MAX_AUDIO_DURATION_SECONDS) throw new UserFacingError('Voice notes can be at most 5 minutes long.', 'MEDIA_DURATION');
      } catch (e) {
        if (e instanceof UserFacingError) throw e;
        throw new UserFacingError('That audio file looks corrupt. Please record it again.', 'MEDIA_CORRUPT');
      }
    }
    const scan = await this.scanner.scan(data).catch((e) => {
      this.log.error({ err: (e as Error).message }, 'upload scan failed; rejecting');
      throw new UserFacingError('I could not safely check that file right now. Please try again shortly.', 'MEDIA_SCAN');
    });
    if (!scan.clean) {
      this.log.warn({ signature: scan.signature }, 'upload rejected by scanner');
      throw new UserFacingError('That file was rejected by the security scan.', 'MEDIA_INFECTED');
    }
    return this.store(tenantId, data, detected, kind, input.draftId, EXTENSION[detected]);
  }

  private async store(tenantId: string, data: Buffer, mime: string, kind: IngestInput['kind'], draftId: string | undefined, ext: string): Promise<MediaRef> {
    const key = `${MediaService.keyPrefix(tenantId)}${kind}/${randomUUID()}.${ext}`;
    await this.storage.put(key, data, mime);
    await this.db.tenantTx(tenantId, (tx) => tx.insert(mediaObjects).values({ key, tenantId, kind, mimeType: mime, size: data.length, draftId }));
    M.tenantUsage().inc({ tenant: tenantId, kind: 'media_bytes' }, data.length);
    return { key, mimeType: mime, size: data.length, source: kind === 'voice' ? 'voice' : kind === 'card' ? 'card' : 'attachment' };
  }

  /** Read bytes; the key must belong to the caller's tenant. */
  async load(tenantId: string, key: string): Promise<Buffer> {
    if (!key.startsWith(MediaService.keyPrefix(tenantId)) || key.includes('..')) throw new UserFacingError('Not found.', 'MEDIA_FORBIDDEN');
    return this.storage.get(key);
  }

  /** Expiring authorized link; never a public URL. */
  async signedUrl(tenantId: string, key: string, ttlSeconds = 300): Promise<string> {
    if (!key.startsWith(MediaService.keyPrefix(tenantId))) throw new UserFacingError('Not found.', 'MEDIA_FORBIDDEN');
    return this.storage.signedGetUrl(key, Math.min(ttlSeconds, 900));
  }

  /**
   * Retention sweep (SEC-04): abandoned media after 24h, confirmed media after the
   * retention period. Returns number of objects deleted.
   */
  async cleanup(now: Date = new Date(), abandonedHours = 24): Promise<number> {
    const cutoff = new Date(now.getTime() - abandonedHours * 3600_000);
    const rows = await this.db.systemTx(async (tx) => {
      // Abandoned: never confirmed, and either no live draft or the draft is terminal-without-commit.
      return tx
        .select({ key: mediaObjects.key, tenantId: mediaObjects.tenantId })
        .from(mediaObjects)
        .leftJoin(drafts, eq(drafts.id, mediaObjects.draftId))
        .where(and(isNull(mediaObjects.deletedAt), or(
          and(isNull(mediaObjects.confirmedAt), lt(mediaObjects.createdAt, cutoff), or(isNull(drafts.id), inArray(drafts.state, ['cancelled', 'expired', 'needs_repair']))),
          and(isNotNull(mediaObjects.deleteAfter), lt(mediaObjects.deleteAfter, now)),
          and(isNull(mediaObjects.confirmedAt), isNull(mediaObjects.draftId), lt(mediaObjects.createdAt, cutoff)),
        )))
        .limit(500);
    });
    let n = 0;
    for (const r of rows) {
      try {
        await this.storage.delete(r.key);
        await this.db.tenantTx(r.tenantId, (tx) => tx.update(mediaObjects).set({ deletedAt: new Date() }).where(eq(mediaObjects.key, r.key)));
        n++;
      } catch (e) {
        this.log.error({ err: (e as Error).message }, 'media deletion failed; will retry next sweep');
      }
    }
    return n;
  }
}

