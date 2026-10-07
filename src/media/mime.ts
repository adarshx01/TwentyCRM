/** Content sniffing from magic bytes: the declared MIME type or filename is never trusted (CAP-01, SEC-01). */
export type DetectedMime = 'image/jpeg' | 'image/png' | 'audio/ogg' | 'audio/mpeg' | 'audio/mp4' | 'audio/wav' | 'audio/webm' | null;

export function detectMime(b: Buffer): DetectedMime {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 4 && b.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (b.length >= 3 && b.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm';
  return null;
}

export const IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
export const AUDIO_TYPES = new Set(['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm']);
export const EXTENSION: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/webm': 'webm' };
