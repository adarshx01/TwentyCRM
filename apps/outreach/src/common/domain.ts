const CONSUMER_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'zoho.com',
]);

export function hostnameFromUrlOrHost(input: string | undefined | null): string | null {
  if (!input) {
    return null;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const withProto = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
    const url = new URL(withProto);
    return url.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return trimmed.replace(/^www\./i, '').split('/')[0]?.toLowerCase() ?? null;
  }
}

export function domainFromEmail(email: string | undefined | null): string | null {
  if (!email || !email.includes('@')) {
    return null;
  }
  const domain = email.split('@').pop()?.trim().toLowerCase() ?? null;
  if (!domain) {
    return null;
  }
  if (CONSUMER_DOMAINS.has(domain)) {
    return null;
  }
  return domain;
}

export function isConsumerEmailDomain(domain: string | null): boolean {
  if (!domain) {
    return true;
  }
  return CONSUMER_DOMAINS.has(domain.toLowerCase());
}

export function originFromHost(host: string): string {
  return `https://${host.replace(/\/$/, '')}`;
}

export function closedStage(stage: string | undefined | null): boolean {
  if (!stage) {
    return false;
  }
  return /won|lost|closed/i.test(stage);
}

export function outreachFooter(params: {
  opportunityId: string;
  step: number;
  status: 'draft' | 'sent' | 'skipped' | 'reply-received';
}): string {
  return `<!-- rb-outreach:opportunity=${params.opportunityId}:step=${params.step}:status=${params.status} -->`;
}

export function parseOutreachFooter(markdown: string | undefined | null): {
  opportunityId: string;
  step: number;
  status: string;
} | null {
  if (!markdown) {
    return null;
  }
  const match = markdown.match(
    /<!--\s*rb-outreach:opportunity=([0-9a-f-]+):step=(\d+):status=([a-z-]+)\s*-->/i,
  );
  if (!match) {
    return null;
  }
  return {
    opportunityId: match[1],
    step: Number(match[2]),
    status: match[3],
  };
}

export function idempotencyKey(opportunityId: string, step: number): string {
  return `${opportunityId}:${step}`;
}
