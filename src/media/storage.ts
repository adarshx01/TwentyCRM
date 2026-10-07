import { mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AppConfig } from '../config/configuration';

export const STORAGE = 'STORAGE';

/** Private object storage port: never publicly readable, access via expiring signed URLs (Section 2). */
export interface StorageProvider {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  signedGetUrl(key: string, ttlSeconds: number): Promise<string>;
  ping(): Promise<boolean>;
}

export class S3Storage implements StorageProvider {
  private readonly s3: S3Client;
  constructor(private readonly cfg: AppConfig['s3']) {
    this.s3 = new S3Client({
      region: cfg.region, endpoint: cfg.endpoint, forcePathStyle: true,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    });
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: undefined }));
  }
  async get(key: string) {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
  signedGetUrl(key: string, ttlSeconds: number) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), { expiresIn: ttlSeconds });
  }
  async ping() {
    try { await this.s3.send(new HeadBucketCommand({ Bucket: this.cfg.bucket })); return true; } catch { return false; }
  }
}

/** Development/test storage on the local filesystem. Not for production. */
export class LocalStorage implements StorageProvider {
  private readonly root: string;
  constructor(dir: string) { this.root = resolve(dir); }
  private path(key: string): string {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return p;
  }
  async put(key: string, body: Buffer) { const p = this.path(key); await mkdir(dirname(p), { recursive: true }); await writeFile(p, body); }
  async get(key: string) { return readFile(this.path(key)); }
  async delete(key: string) { await rm(this.path(key), { force: true }); }
  async signedGetUrl(): Promise<string> { throw new Error('signed URLs are not supported by local storage'); }
  async ping() { try { await access(this.root); return true; } catch { try { await mkdir(this.root, { recursive: true }); return true; } catch { return false; } } }
}

export function createStorage(config: AppConfig): StorageProvider {
  return config.storage.driver === 'local' ? new LocalStorage(config.storage.localDir) : new S3Storage(config.s3);
}
