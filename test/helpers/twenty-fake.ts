import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * In-memory Twenty server for deterministic tests. It enforces the behaviours the
 * adapter must cope with: workspace isolation by API key, 100 req/min limit with
 * Retry-After, cursor pagination (max 60), strict field validation (custom
 * fields must be provisioned) and injectable failures (including "applied, but
 * the response never arrives").
 */
type Rec = Record<string, any>;

const SINGULAR: Record<string, string> = {
  people: 'person', companies: 'company', opportunities: 'opportunity', notes: 'note', tasks: 'task',
  noteTargets: 'noteTarget', taskTargets: 'taskTarget', intakeReviews: 'intakeReview',
};
const STANDARD: Record<string, string[]> = {
  person: ['name', 'emails', 'phones', 'jobTitle', 'companyId', 'city'],
  company: ['name', 'domainName', 'address', 'employees'],
  opportunity: ['name', 'amount', 'closeDate', 'stage', 'pointOfContactId', 'companyId'],
  note: ['title', 'bodyV2'],
  task: ['title', 'bodyV2', 'dueAt', 'status', 'assigneeId'],
  noteTarget: ['noteId', 'personId', 'companyId', 'opportunityId'],
  taskTarget: ['taskId', 'personId', 'companyId', 'opportunityId'],
  intakeReview: ['name'],
};

export interface Injection {
  match: (method: string, path: string, body: Rec | null) => boolean;
  /** hang_after_apply: apply the write, then never answer (client times out) */
  mode: 'hang_after_apply' | 'hang_before_apply' | 'status';
  status?: number;
  times: number;
}

export class FakeTwentyWorkspace {
  data: Record<string, Rec[]> = {};
  customFields: Record<string, Set<string>> = {};
  stageOptions: Array<{ value: string; label: string }> = ['NEW', 'SCREENING', 'MEETING', 'PROPOSAL', 'CUSTOMER'].map((v) => ({ value: v, label: v }));
  objects: Rec[] = [];
  calls: Array<{ method: string; path: string; at: number }> = [];

  constructor(readonly name: string) {
    for (const plural of Object.keys(SINGULAR)) this.data[plural] = [];
    for (const [s, fields] of Object.entries(STANDARD)) this.customFields[s] = new Set();
    this.rebuildObjects();
  }

  rebuildObjects() {
    this.objects = ['person', 'company', 'opportunity', 'note', 'task'].map((s) => this.objectDef(s));
  }

  objectDef(singular: string): Rec {
    const plural = Object.keys(SINGULAR).find((p) => SINGULAR[p] === singular)!;
    const std = STANDARD[singular].map((n) => ({ id: `${singular}.${n}`, name: n, type: 'TEXT', options: n === 'stage' ? this.stageOptions : undefined }));
    const custom = [...this.customFields[singular]].map((n) => ({ id: `${singular}.${n}`, name: n, type: 'TEXT' }));
    return { id: `obj_${singular}`, nameSingular: singular, namePlural: plural, fields: [...std, ...custom] };
  }

  all(plural: string): Rec[] { return this.data[plural]; }
  find(plural: string, pred: (r: Rec) => boolean): Rec[] { return this.data[plural].filter(pred); }
  byKey(plural: string, key: string): Rec[] { return this.data[plural].filter((r) => r.beeOperationKey === key); }
}

function getPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// ── filter grammar: and(...), or(...), field[op]:value ─────────
type Pred = (r: Rec) => boolean;
function parseFilter(src: string): Pred {
  let i = 0;
  const peek = () => src[i];
  const parseExpr = (): Pred => {
    for (const name of ['and', 'or']) {
      if (src.startsWith(name + '(', i)) {
        i += name.length + 1;
        const parts: Pred[] = [parseExpr()];
        while (peek() === ',') { i++; parts.push(parseExpr()); }
        if (peek() !== ')') throw new Error('expected )');
        i++;
        return name === 'and' ? (r) => parts.every((p) => p(r)) : (r) => parts.some((p) => p(r));
      }
    }
    const m = /^([A-Za-z0-9_.]+)\[(\w+)\]:/.exec(src.slice(i));
    if (!m) throw new Error(`bad filter at ${i}: ${src.slice(i, i + 20)}`);
    i += m[0].length;
    const [, field, op] = m;
    const value = parseValue();
    return (r) => {
      const v = getPath(r, field);
      switch (op) {
        case 'eq': return v === value || (v == null && value === null);
        case 'neq': return v !== value;
        case 'in': return Array.isArray(value) && value.includes(v);
        case 'gte': return v != null && String(v) >= String(value);
        case 'lte': return v != null && String(v) <= String(value);
        case 'ilike': {
          if (v == null) return false;
          const re = new RegExp('^' + String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i');
          return re.test(String(v));
        }
        default: throw new Error(`unsupported op ${op}`);
      }
    };
  };
  const parseValue = (): any => {
    if (peek() === '"') {
      const end = src.indexOf('"', i + 1);
      const s = src.slice(i + 1, end);
      i = end + 1;
      return s;
    }
    if (peek() === '[') {
      i++;
      const arr: any[] = [];
      while (peek() !== ']') { arr.push(parseValue()); if (peek() === ',') i++; }
      i++;
      return arr;
    }
    const m = /^[^,)\]]+/.exec(src.slice(i))!;
    i += m[0].length;
    return m[0] === 'true' ? true : m[0] === 'false' ? false : m[0] === 'NULL' ? null : m[0];
  };
  const p = parseExpr();
  if (i !== src.length) throw new Error('trailing filter input');
  return p;
}

export class FakeTwenty {
  server!: Server;
  url = '';
  workspaces = new Map<string, FakeTwentyWorkspace>();
  tokenToWorkspace = new Map<string, string>();
  rateLimitPerMin = 100;
  private windows = new Map<string, number[]>();
  injections: Injection[] = [];
  /** Delay added to every response (ms) to simulate latency */
  latencyMs = 0;
  requestCount = 0;
  rateLimited = 0;
  inflight = 0;
  maxInflight = 0;
  private hung: ServerResponse[] = [];

  addWorkspace(name: string, token: string): FakeTwentyWorkspace {
    const ws = new FakeTwentyWorkspace(name);
    this.workspaces.set(name, ws);
    this.tokenToWorkspace.set(token, name);
    return ws;
  }

  inject(i: Injection) { this.injections.push(i); }

  async start(): Promise<string> {
    this.server = createServer((req, res) => { this.handle(req, res).catch((e) => { res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); }); });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const addr = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${addr.port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    for (const h of this.hung) h.destroy();
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private async readBody(req: IncomingMessage): Promise<Rec | null> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const s = Buffer.concat(chunks).toString();
    return s ? JSON.parse(s) : null;
  }

  private send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    this.requestCount++;
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    res.on('close', () => { this.inflight--; });
    const url = new URL(req.url!, this.url);
    const method = req.method!;
    const body = ['POST', 'PATCH', 'PUT'].includes(method) ? await this.readBody(req) : null;
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));

    const token = (req.headers.authorization ?? '').replace('Bearer ', '');
    const wsName = this.tokenToWorkspace.get(token);
    if (!wsName) return this.send(res, 401, { error: 'unauthorized' });
    const ws = this.workspaces.get(wsName)!;
    ws.calls.push({ method, path: url.pathname, at: Date.now() });

    // rate limit per API key
    const now = Date.now();
    const win = (this.windows.get(token) ?? []).filter((t) => now - t < 60_000);
    if (win.length >= this.rateLimitPerMin) {
      this.rateLimited++;
      this.windows.set(token, win);
      return this.send(res, 429, { error: 'rate limited' }, { 'retry-after': String(Math.max(1, Math.ceil((60_000 - (now - win[0])) / 1000))) });
    }
    win.push(now);
    this.windows.set(token, win);

    const inj = this.injections.find((i) => i.times > 0 && i.match(method, url.pathname, body));
    if (inj) {
      inj.times--;
      if (inj.mode === 'status') return this.send(res, inj.status ?? 500, { error: 'injected' });
      if (inj.mode === 'hang_before_apply') { this.hung.push(res); return; }
    }

    const result = this.route(ws, method, url, body);
    if (inj?.mode === 'hang_after_apply') { this.hung.push(res); return; }
    this.send(res, result.status, result.body);
  }

  private route(ws: FakeTwentyWorkspace, method: string, url: URL, body: Rec | null): { status: number; body?: unknown } {
    const parts = url.pathname.split('/').filter(Boolean); // rest, ...
    if (parts[0] !== 'rest') return { status: 404 };
    if (parts[1] === 'metadata') return this.metadata(ws, method, parts.slice(2), body);
    const plural = parts[1];
    const singular = SINGULAR[plural];
    if (!singular) return { status: 404, body: { error: 'unknown object' } };
    const id = parts[2];
    const cap = singular[0].toUpperCase() + singular.slice(1);

    if (method === 'GET' && !id) {
      let pred: Pred = () => true;
      const f = url.searchParams.get('filter');
      if (f) { try { pred = parseFilter(f); } catch (e) { return { status: 400, body: { messages: [String(e)] } }; } }
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 60), 60);
      const after = url.searchParams.get('starting_after');
      let rows = ws.data[plural].filter(pred);
      const total = rows.length;
      if (after) { const idx = rows.findIndex((r) => r.id === after); rows = rows.slice(idx + 1); }
      const page = rows.slice(0, limit);
      const hasNext = rows.length > limit;
      return { status: 200, body: { data: { [plural]: page }, pageInfo: { hasNextPage: hasNext, startCursor: page[0]?.id, endCursor: page[page.length - 1]?.id }, totalCount: total } };
    }
    if (method === 'GET' && id) {
      const r = ws.data[plural].find((x) => x.id === id);
      return r ? { status: 200, body: { data: { [singular]: r } } } : { status: 404, body: { messages: ['not found'] } };
    }
    if (method === 'POST') {
      const err = this.validate(ws, singular, body ?? {});
      if (err) return { status: 400, body: { messages: [err] } };
      const rec: Rec = { id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null, ...body };
      for (const f of ws.customFields[singular]) if (!(f in rec)) rec[f] = f === 'beeArchived' ? false : null;
      ws.data[plural].push(rec);
      return { status: 201, body: { data: { [`create${cap}`]: rec } } };
    }
    if (method === 'PATCH' && id) {
      const r = ws.data[plural].find((x) => x.id === id);
      if (!r) return { status: 404, body: { messages: ['not found'] } };
      const err = this.validate(ws, singular, body ?? {});
      if (err) return { status: 400, body: { messages: [err] } };
      Object.assign(r, body, { updatedAt: new Date(Math.max(Date.now(), Date.parse(r.updatedAt) + 1)).toISOString() });
      return { status: 200, body: { data: { [`update${cap}`]: r } } };
    }
    // Hard deletes are deliberately unsupported: archive is a field flag (Section 4).
    return { status: 405, body: { messages: ['method not allowed'] } };
  }

  private validate(ws: FakeTwentyWorkspace, singular: string, body: Rec): string | null {
    for (const k of Object.keys(body)) {
      if (!STANDARD[singular].includes(k) && !ws.customFields[singular].has(k)) return `Field "${k}" does not exist on ${singular}`;
    }
    if (singular === 'opportunity' && body.stage && !ws.stageOptions.some((o) => o.value === body.stage)) return `Invalid stage ${body.stage}`;
    return null;
  }

  private metadata(ws: FakeTwentyWorkspace, method: string, parts: string[], body: Rec | null): { status: number; body?: unknown } {
    if (parts[0] === 'objects' && method === 'GET') {
      return { status: 200, body: { data: { objects: ws.objects.map((o) => ws.objectDef(o.nameSingular)) } } };
    }
    if (parts[0] === 'objects' && method === 'POST') {
      const s = body!.nameSingular as string;
      if (!ws.customFields[s]) { ws.customFields[s] = new Set(); STANDARD[s] ??= ['name']; SINGULAR[body!.namePlural] = s; ws.data[body!.namePlural] ??= []; }
      const def = ws.objectDef(s);
      if (!ws.objects.some((o) => o.nameSingular === s)) ws.objects.push(def);
      return { status: 201, body: { data: { createOneObject: def } } };
    }
    if (parts[0] === 'fields' && method === 'POST') {
      const objId = String(body!.objectMetadataId);
      const singular = objId.replace('obj_', '');
      if (!ws.customFields[singular]) return { status: 404, body: { messages: ['object not found'] } };
      ws.customFields[singular].add(String(body!.name));
      return { status: 201, body: { data: { createOneField: { id: `${singular}.${body!.name}`, name: body!.name } } } };
    }
    if (parts[0] === 'fields' && method === 'PATCH') {
      if (parts[1] === 'opportunity.stage' && body?.options) ws.stageOptions = body.options;
      return { status: 200, body: { data: { updateOneField: { id: parts[1] } } } };
    }
    return { status: 404 };
  }
}
