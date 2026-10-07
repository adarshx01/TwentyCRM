import { connect } from 'node:net';
import type { AppConfig } from '../config/configuration';

export const SCANNER = 'SCANNER';

export interface ScanResult { clean: boolean; signature?: string }
export interface Scanner { scan(data: Buffer): Promise<ScanResult>; readonly enabled: boolean }

export class NoopScanner implements Scanner {
  readonly enabled = false;
  async scan(): Promise<ScanResult> { return { clean: true }; }
}

/** ClamAV daemon over TCP (INSTREAM). Fails closed: scanner errors reject the upload (SEC-01). */
export class ClamAvScanner implements Scanner {
  readonly enabled = true;
  constructor(private readonly host: string, private readonly port: number, private readonly timeoutMs = 15_000) {}

  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      let response = '';
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('scanner timeout')); }, this.timeoutMs);
      socket.on('error', (e) => { clearTimeout(timer); reject(e); });
      socket.on('data', (d) => { response += d.toString(); });
      socket.on('close', () => {
        clearTimeout(timer);
        if (/OK\s*$/.test(response.replace(/\0/g, ''))) return resolve({ clean: true });
        const m = /stream:\s*(.+) FOUND/.exec(response);
        if (m) return resolve({ clean: false, signature: m[1] });
        reject(new Error(`unexpected scanner response: ${response.slice(0, 80)}`));
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        const CHUNK = 64 * 1024;
        for (let i = 0; i < data.length; i += CHUNK) {
          const part = data.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4); len.writeUInt32BE(part.length);
          socket.write(len); socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}

export function createScanner(config: AppConfig): Scanner {
  return config.scanner.clamavHost ? new ClamAvScanner(config.scanner.clamavHost, config.scanner.clamavPort) : new NoopScanner();
}
