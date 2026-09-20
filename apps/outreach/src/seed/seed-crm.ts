import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

type Json = Record<string, unknown>;

function loadEnv() {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq < 1) {
      continue;
    }
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnv();

const BASE = (process.env.TWENTY_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env.TWENTY_API_KEY ?? '';

if (!KEY) {
  console.error('TWENTY_API_KEY is missing. Copy apps/outreach/.env.example to .env and paste the key from Twenty.');
  process.exit(1);
}

const COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'turquoise', 'yellow', 'gray', 'pink'] as const;

function option(label: string, value: string, position: number) {
  return {
    id: randomUUID(),
    label,
    value,
    color: COLORS[position % COLORS.length],
    position,
  };
}

async function request(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { ok: res.ok, status: res.status, json, text };
}

async function graphql(query: string, variables?: Json) {
  return request('/metadata', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
}

function asArray(value: unknown): Json[] {
  if (Array.isArray(value)) {
    return value as Json[];
  }
  if (value && typeof value === 'object') {
    const rec = value as Json;
    for (const key of ['objects', 'fields', 'edges', 'data']) {
      if (Array.isArray(rec[key])) {
        return rec[key] as Json[];
      }
    }
    if (Array.isArray((rec.data as Json | undefined)?.objects)) {
      return ((rec.data as Json).objects as Json[]);
    }
    if (Array.isArray((rec.data as Json | undefined)?.fields)) {
      return ((rec.data as Json).fields as Json[]);
    }
  }
  return [];
}

async function listObjects(): Promise<Json[]> {
  const attempts = [
    () => request('/rest/metadata/objects'),
    () => request('/rest/metadata/objectsMetadata'),
    () =>
      graphql(`query { objects { id nameSingular namePlural labelSingular } }`),
    () =>
      graphql(
        `query { objects(paging: { first: 200 }) { edges { node { id nameSingular namePlural labelSingular } } } }`,
      ),
  ];
  for (const run of attempts) {
    const res = await run();
    if (!res.ok) {
      continue;
    }
    let rows = asArray(res.json);
    const data = (res.json as Json)?.data as Json | undefined;
    const objects = data?.objects as Json | undefined;
    const edges = (objects as Json | undefined)?.edges as { node: Json }[] | undefined;
    if (edges?.length) {
      rows = edges.map((e) => e.node);
    }
    if (rows.length) {
      return rows.map((row) => {
        const node = (row.node as Json) ?? row;
        return node;
      });
    }
  }
  return [];
}

async function listFields(objectId: string): Promise<Json[]> {
  const paths = [
    `/rest/metadata/fields?filter=objectMetadataId[eq]:"${objectId}"`,
    `/rest/metadata/fields`,
  ];
  for (const path of paths) {
    const res = await request(path);
    if (!res.ok) {
      continue;
    }
    const rows = asArray(res.json);
    if (!rows.length) {
      continue;
    }
    const forObject = rows.filter((f) => {
      const oid = String(f.objectMetadataId ?? asArray(f.object)[0] ?? '');
      return !oid || oid === objectId;
    });
    if (path.includes('filter')) {
      return rows;
    }
    if (forObject.length) {
      return forObject;
    }
    return rows;
  }
  return [];
}

async function createObject() {
  const rest = await request('/rest/metadata/objects', {
    method: 'POST',
    body: JSON.stringify({
      nameSingular: 'outreachJob',
      namePlural: 'outreachJobs',
      labelSingular: 'Outreach Job',
      labelPlural: 'Outreach Jobs',
      icon: 'IconMail',
    }),
  });
  if (rest.ok) {
    console.log('Created custom object outreachJob (REST)');
    return;
  }
  const gql = await graphql(`
    mutation {
      createOneObject(
        input: {
          object: {
            nameSingular: "outreachJob"
            namePlural: "outreachJobs"
            labelSingular: "Outreach Job"
            labelPlural: "Outreach Jobs"
            icon: "IconMail"
          }
        }
      ) { id nameSingular }
    }
  `);
  if (gql.ok && !(gql.json as Json)?.errors) {
    console.log('Created custom object outreachJob (GraphQL)');
    return;
  }
  console.warn('Could not create OutreachJob object. Notes + Opportunity fields still work.');
  console.warn(rest.text.slice(0, 300) || JSON.stringify(gql.json).slice(0, 300));
}

async function createField(objectId: string, field: Json, existing: Json[]) {
  const name = String(field.name);
  if (existing.some((f) => f.name === name)) {
    console.log(`Field ${name} already exists`);
    return;
  }
  const rest = await request('/rest/metadata/fields', {
    method: 'POST',
    body: JSON.stringify({ objectMetadataId: objectId, ...field }),
  });
  if (rest.ok) {
    console.log(`Created field ${name}`);
    return;
  }
  if (rest.text.includes('NOT_AVAILABLE') || rest.text.includes('already used')) {
    console.log(`Field ${name} already exists`);
    return;
  }
  const gql = await graphql(
    `mutation ($input: CreateFieldInput!) { createOneField(input: $input) { id name } }`,
    { input: { objectMetadataId: objectId, ...field } },
  );
  if (gql.ok && !(gql.json as Json)?.errors) {
    console.log(`Created field ${name} (GraphQL)`);
    return;
  }
  console.warn(`Could not create field ${name}: ${(rest.text || JSON.stringify(gql.json)).slice(0, 280)}`);
}

async function tryUpdateStage(opportunity: Json) {
  const fields = await listFields(String(opportunity.id));
  console.log(
    'Opportunity fields:',
    fields.map((f) => `${f.name}:${String(f.id ?? '').slice(0, 8)}`).join(', ') || '(none listed)',
  );
  const stage = fields.find(
    (f) => String(f.name).toLowerCase() === 'stage' || String(f.label).toLowerCase() === 'stage',
  );
  if (!stage?.id) {
    console.warn('Could not find Opportunity.stage to update options. Use the playbook.');
    return;
  }
  const options = [
    option('New', 'NEW', 0),
    option('Contacted', 'CONTACTED', 1),
    option('Qualified', 'QUALIFIED', 2),
    option('Demo scheduled', 'DEMO_SCHEDULED', 3),
    option('Demo completed', 'DEMO_COMPLETED', 4),
    option('Proposal', 'PROPOSAL', 5),
    option('Negotiation', 'NEGOTIATION', 6),
    option('Closed won', 'CLOSED_WON', 7),
    option('Closed lost', 'CLOSED_LOST', 8),
  ];
  const patch = await request(`/rest/metadata/fields/${stage.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ options }),
  });
  if (patch.ok) {
    console.log('Updated Opportunity.stage options');
    return;
  }
  console.warn('Could not rewrite stage options via API. Rename them in Settings → Data Model → Opportunities → Stage.');
}

async function main() {
  console.log(`Seeding CRM against ${BASE}`);
  await createObject();
  const objects = await listObjects();
  if (!objects.length) {
    console.error('Could not list metadata objects. Finish setup in the UI — see src/seed/PLAYBOOK.md');
    process.exit(2);
  }

  const bySingular = (name: string) =>
    objects.find((o) => String(o.nameSingular).toLowerCase() === name.toLowerCase());

  const company = bySingular('company') ?? bySingular('companies');
  const person = bySingular('person') ?? bySingular('people');
  const opportunity = bySingular('opportunity');
  const outreachJob = bySingular('outreachJob');

  if (company?.id) {
    const fields = await listFields(String(company.id));
    await createField(String(company.id), { name: 'employeeRange', label: 'Employee range', type: 'SELECT', options: [
      option('1–50', 'RANGE_1_50', 0),
      option('51–200', 'RANGE_51_200', 1),
      option('201–1000', 'RANGE_201_1000', 2),
      option('1000+', 'RANGE_1000_PLUS', 3),
    ] }, fields);
    await createField(String(company.id), { name: 'currentAts', label: 'Current ATS', type: 'TEXT' }, fields);
    await createField(String(company.id), { name: 'hiringVolume', label: 'Hiring volume', type: 'SELECT', options: [
      option('Low', 'LOW', 0),
      option('Medium', 'MEDIUM', 1),
      option('High', 'HIGH', 2),
    ] }, fields);
    await createField(String(company.id), { name: 'researchSummary', label: 'Research summary', type: 'TEXT' }, fields);
  } else {
    console.warn('Company object not found');
  }

  if (person?.id) {
    const fields = await listFields(String(person.id));
    await createField(String(person.id), { name: 'buyerRole', label: 'Buyer role', type: 'SELECT', options: [
      option('CHRO', 'CHRO', 0),
      option('TA Head', 'TA_HEAD', 1),
      option('Recruiter', 'RECRUITER', 2),
      option('Hiring manager', 'HIRING_MANAGER', 3),
      option('Other', 'OTHER', 4),
    ] }, fields);
  } else {
    console.warn('Person object not found');
  }

  if (opportunity?.id) {
    const fields = await listFields(String(opportunity.id));
    await createField(String(opportunity.id), { name: 'solutionInterest', label: 'Solution interest', type: 'SELECT', options: [
      option('Action-Enabled System', 'AES', 0),
      option('VoiceBot', 'VOICEBOT', 1),
      option('Resume Analyzer', 'RESUME_ANALYZER', 2),
      option('WhatsApp', 'WHATSAPP', 3),
      option('Reverse Match', 'REVERSE_MATCH', 4),
      option('Career pages', 'CAREER_PAGES', 5),
      option('Analytics', 'ANALYTICS', 6),
    ] }, fields);
    await createField(String(opportunity.id), { name: 'source', label: 'Source', type: 'SELECT', options: [
      option('Website', 'WEBSITE', 0),
      option('Manual', 'MANUAL', 1),
      option('Referral', 'REFERRAL', 2),
      option('LinkedIn', 'LINKEDIN', 3),
      option('Event', 'EVENT', 4),
      option('Other', 'OTHER', 5),
    ] }, fields);
    await createField(String(opportunity.id), { name: 'utmSource', label: 'UTM source', type: 'TEXT' }, fields);
    await createField(String(opportunity.id), { name: 'utmMedium', label: 'UTM medium', type: 'TEXT' }, fields);
    await createField(String(opportunity.id), { name: 'utmCampaign', label: 'UTM campaign', type: 'TEXT' }, fields);
    await createField(String(opportunity.id), { name: 'outreachMode', label: 'Outreach mode', type: 'SELECT', options: [
      option('Draft', 'DRAFT', 0),
      option('Auto', 'AUTO', 1),
    ] }, fields);
    await createField(String(opportunity.id), { name: 'sequenceStep', label: 'Sequence step', type: 'NUMBER' }, fields);
    await createField(String(opportunity.id), { name: 'nextFollowUpAt', label: 'Next follow-up', type: 'DATE_TIME' }, fields);
    await createField(String(opportunity.id), { name: 'stopOutreach', label: 'Stop outreach', type: 'BOOLEAN' }, fields);
    await createField(String(opportunity.id), { name: 'lastOutreachKey', label: 'Last outreach key', type: 'TEXT' }, fields);
    await tryUpdateStage(opportunity);
  } else {
    console.warn('Opportunity object not found');
  }

  if (outreachJob?.id) {
    const fields = await listFields(String(outreachJob.id));
    await createField(String(outreachJob.id), { name: 'status', label: 'Status', type: 'SELECT', options: [
      option('Queued', 'QUEUED', 0),
      option('Researching', 'RESEARCHING', 1),
      option('Drafted', 'DRAFTED', 2),
      option('Approved', 'APPROVED', 3),
      option('Sent', 'SENT', 4),
      option('Skipped', 'SKIPPED', 5),
      option('Failed', 'FAILED', 6),
    ] }, fields);
    await createField(String(outreachJob.id), { name: 'mode', label: 'Mode', type: 'SELECT', options: [
      option('Draft', 'DRAFT', 0),
      option('Auto', 'AUTO', 1),
    ] }, fields);
    await createField(String(outreachJob.id), { name: 'sequenceStep', label: 'Sequence step', type: 'NUMBER' }, fields);
    await createField(String(outreachJob.id), { name: 'lastError', label: 'Last error', type: 'TEXT' }, fields);
    await createField(String(outreachJob.id), { name: 'idempotencyKey', label: 'Idempotency key', type: 'TEXT' }, fields);
    await createField(
      String(outreachJob.id),
      {
        name: 'opportunity',
        label: 'Opportunity',
        type: 'RELATION',
        relationCreationPayload: {
          type: 'MANY_TO_ONE',
          targetObjectMetadataId: opportunity?.id,
          targetObjectNameSingular: 'opportunity',
          targetFieldLabel: 'Outreach Jobs',
          targetFieldIcon: 'IconMail',
        },
      },
      fields,
    );
  }

  console.log('Seed finished. If any field failed, complete it from src/seed/PLAYBOOK.md');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
