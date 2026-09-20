export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function relationId(value: unknown): string | undefined {
  if (typeof value === 'string' && value) {
    return value;
  }
  const rec = asRecord(value);
  if (rec && typeof rec.id === 'string') {
    return rec.id;
  }
  return undefined;
}

export function primaryEmail(person: Record<string, unknown> | null): string | undefined {
  if (!person) {
    return undefined;
  }
  const emails = asRecord(person.emails);
  if (emails && typeof emails.primaryEmail === 'string') {
    return emails.primaryEmail;
  }
  if (typeof person.email === 'string') {
    return person.email;
  }
  return undefined;
}

export function personName(person: Record<string, unknown> | null): { first: string; last: string } {
  const name = asRecord(person?.name);
  return {
    first: String(name?.firstName ?? person?.firstName ?? ''),
    last: String(name?.lastName ?? person?.lastName ?? ''),
  };
}

export function companyDomain(company: Record<string, unknown> | null): string | undefined {
  if (!company) {
    return undefined;
  }
  const domain = asRecord(company.domainName);
  if (domain && typeof domain.primaryLinkUrl === 'string') {
    return domain.primaryLinkUrl;
  }
  if (typeof company.domainName === 'string') {
    return company.domainName;
  }
  return undefined;
}

export function companyWebsite(company: Record<string, unknown> | null): string | undefined {
  if (!company) {
    return undefined;
  }
  const website = asRecord(company.website);
  if (website && typeof website.primaryLinkUrl === 'string') {
    return website.primaryLinkUrl;
  }
  if (typeof company.website === 'string') {
    return company.website;
  }
  return undefined;
}

export function selectValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  const rec = asRecord(value);
  if (rec && typeof rec === 'object') {
    if (typeof rec.value === 'string') {
      return rec.value;
    }
  }
  return undefined;
}

export function boolValue(value: unknown): boolean {
  return value === true || value === 'true';
}
