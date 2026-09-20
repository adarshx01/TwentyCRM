export type DraftEmail = {
  subject: string;
  bodyText: string;
  whyThisAngle: string;
};

export function parseDraftJson(raw: string): DraftEmail {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const parsed = JSON.parse(cleaned) as Partial<DraftEmail>;
  if (!parsed.subject || !parsed.bodyText) {
    throw new Error('Draft JSON missing subject or bodyText');
  }
  return {
    subject: String(parsed.subject).trim(),
    bodyText: String(parsed.bodyText).trim(),
    whyThisAngle: String(parsed.whyThisAngle ?? '').trim(),
  };
}
