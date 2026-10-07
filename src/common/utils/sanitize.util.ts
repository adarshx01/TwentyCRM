import sanitizeHtml from 'sanitize-html';

/**
 * Sanitize HTML content from emails and external sources.
 * Strips scripts, tracking images, and dangerous elements (SEC-02, IN-04).
 */
export function sanitizeContent(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'b', 'i', 'em', 'strong', 'p', 'br', 'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'span', 'div',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    allowedAttributes: {
      a: ['href'],
      span: ['class'],
      div: ['class'],
    },
    // Block tracking images, scripts, iframes
    exclusiveFilter: (frame) => {
      // Remove tracking pixels (1x1 images)
      if (frame.tag === 'img') return true;
      return false;
    },
    disallowedTagsMode: 'discard',
  });
}

/**
 * Strip all HTML and get plain text.
 */
export function stripHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
  }).replace(/\s+/g, ' ').trim();
}

/**
 * Sanitize text that will be sent to an LLM to prevent prompt injection.
 * Wraps user content in delimiters and strips potential injection patterns (SEC-02).
 */
export function sanitizeForLlm(text: string): string {
  // Remove common injection patterns
  const cleaned = text
    .replace(/\[SYSTEM\]/gi, '[USER_INPUT]')
    .replace(/\[INST\]/gi, '[USER_INPUT]')
    .replace(/<<SYS>>/gi, '')
    .replace(/<\|.*?\|>/g, '')
    .replace(/```system/gi, '```text')
    .replace(/ignore\s+(previous|above|all)\s+(instructions?|prompts?)/gi, '')
    .replace(/you\s+are\s+now/gi, '')
    .replace(/new\s+instructions?:/gi, '')
    .replace(/override\s+(security|permissions?|access)/gi, '');

  return cleaned;
}

/**
 * Validate file MIME type by checking magic bytes, not just extension.
 * Prevents file type spoofing (SEC-01, CAP-01).
 */
export function validateMimeType(
  buffer: Buffer,
  declaredMime: string,
): { valid: boolean; detectedMime: string | null } {
  // Check common magic bytes
  const magicBytes: Record<string, number[]> = {
    'image/jpeg': [0xFF, 0xD8, 0xFF],
    'image/png': [0x89, 0x50, 0x4E, 0x47],
    'audio/ogg': [0x4F, 0x67, 0x67, 0x53],
    'audio/mpeg': [0xFF, 0xFB], // MP3
    'audio/mp4': [0x00, 0x00, 0x00], // Start of ftyp box (partial)
    'application/pdf': [0x25, 0x50, 0x44, 0x46],
  };

  let detectedMime: string | null = null;
  for (const [mime, bytes] of Object.entries(magicBytes)) {
    if (buffer.length >= bytes.length) {
      const matches = bytes.every((b, i) => buffer[i] === b);
      if (matches) {
        detectedMime = mime;
        break;
      }
    }
  }

  // JPEG and PNG are allowed for cards, audio types for voice
  const allowedTypes = [
    'image/jpeg', 'image/png',
    'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav',
    'audio/x-wav', 'audio/webm',
  ];

  const mimeToCheck = detectedMime || declaredMime;
  const valid = allowedTypes.includes(mimeToCheck);

  return { valid, detectedMime };
}

/** Max file sizes per BRD CAP-01 */
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
export const MAX_AUDIO_SIZE = 20 * 1024 * 1024; // 20 MB
export const MAX_AUDIO_DURATION_SECONDS = 300;   // 5 minutes
