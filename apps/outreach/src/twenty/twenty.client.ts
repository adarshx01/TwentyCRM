import { Injectable, Logger } from '@nestjs/common';
import { loadConfig, type AppConfig } from '../config/app.config';
import { parseOutreachFooter } from '../common/domain';

export type TwentyRecord = Record<string, unknown>;

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

@Injectable()
export class TwentyClient {
  private readonly log = new Logger(TwentyClient.name);
  private readonly cfg: AppConfig;

  constructor() {
    this.cfg = loadConfig();
  }

  get configured(): boolean {
    return Boolean(this.cfg.twentyApiKey);
  }

  async getOpportunity(id: string, depth = 1): Promise<TwentyRecord> {
    const body = await this.request('GET', `/rest/opportunities/${id}?depth=${depth}`);
    return this.unwrap(body, 'opportunity');
  }

  async getCompany(id: string, depth = 1): Promise<TwentyRecord> {
    const body = await this.request('GET', `/rest/companies/${id}?depth=${depth}`);
    return this.unwrap(body, 'company');
  }

  async getPerson(id: string, depth = 1): Promise<TwentyRecord> {
    const body = await this.request('GET', `/rest/people/${id}?depth=${depth}`);
    return this.unwrap(body, 'person');
  }

  async findOpenOpportunityForPerson(personId: string): Promise<TwentyRecord | null> {
    const filter = encodeURIComponent(`pointOfContactId[eq]:"${personId}"`);
    const body = await this.request('GET', `/rest/opportunities?filter=${filter}&depth=1&limit=20`);
    const list = this.unwrapList(body, 'opportunities');
    const open = list.filter((row) => !/won|lost|closed/i.test(String(row.stage ?? '')));
    return open[0] ?? list[0] ?? null;
  }

  async patchCompany(id: string, data: Record<string, unknown>): Promise<void> {
    try {
      await this.request('PATCH', `/rest/companies/${id}`, data);
    } catch (err) {
      this.log.warn(`PATCH company ${id} failed: ${(err as Error).message}`);
    }
  }

  async patchOpportunity(id: string, data: Record<string, unknown>): Promise<void> {
    try {
      await this.request('PATCH', `/rest/opportunities/${id}`, data);
    } catch (err) {
      this.log.warn(`PATCH opportunity ${id} failed: ${(err as Error).message}`);
    }
  }

  async listNotes(limit = 60): Promise<TwentyRecord[]> {
    const body = await this.request('GET', `/rest/notes?limit=${limit}&depth=1`);
    return this.unwrapList(body, 'notes');
  }

  async findExistingOutreach(opportunityId: string, step: number): Promise<TwentyRecord | null> {
    const needle = `rb-outreach:opportunity=${opportunityId}:step=${step}:`;
    const notes = await this.listNotes(100);
    for (const note of notes) {
      const markdown = this.noteMarkdown(note);
      if (markdown.includes(needle)) {
        return note;
      }
      const parsed = parseOutreachFooter(markdown);
      if (parsed && parsed.opportunityId === opportunityId && parsed.step === step) {
        return note;
      }
    }
    return null;
  }

  async createLinkedNote(params: {
    title: string;
    markdown: string;
    opportunityId?: string;
    companyId?: string;
    personId?: string;
  }): Promise<string> {
    const note = await this.createNote(params.title, params.markdown);
    const noteId = String(note.id);
    if (params.opportunityId) {
      await this.createNoteTarget(noteId, { opportunityId: params.opportunityId });
    }
    if (params.companyId) {
      await this.createNoteTarget(noteId, { companyId: params.companyId });
    }
    if (params.personId) {
      await this.createNoteTarget(noteId, { personId: params.personId });
    }
    return noteId;
  }

  async createReviewTask(params: {
    opportunityId: string;
    companyId?: string;
    personId?: string;
  }): Promise<void> {
    const task = await this.createTask('Review outreach', 'TODO');
    const taskId = String(task.id);
    await this.createTaskTarget(taskId, { opportunityId: params.opportunityId });
    if (params.companyId) {
      await this.createTaskTarget(taskId, { companyId: params.companyId });
    }
    if (params.personId) {
      await this.createTaskTarget(taskId, { personId: params.personId });
    }
  }

  async upsertOutreachJob(params: {
    name: string;
    opportunityId: string;
    status: string;
    mode: string;
    sequenceStep: number;
    lastError?: string;
    idempotencyKey: string;
  }): Promise<void> {
    try {
      const filter = encodeURIComponent(`idempotencyKey[eq]:"${params.idempotencyKey}"`);
      const existing = await this.request('GET', `/rest/outreachJobs?filter=${filter}&limit=1`);
      const rows = this.unwrapList(existing, 'outreachJobs');
      const payload = {
        name: params.name,
        opportunityId: params.opportunityId,
        status: params.status,
        mode: params.mode,
        sequenceStep: params.sequenceStep,
        lastError: params.lastError ?? '',
        idempotencyKey: params.idempotencyKey,
      };
      if (rows[0]?.id) {
        await this.request('PATCH', `/rest/outreachJobs/${rows[0].id}`, payload);
        return;
      }
      await this.request('POST', `/rest/outreachJobs`, payload);
    } catch (err) {
      this.log.debug(`OutreachJob skipped: ${(err as Error).message}`);
    }
  }

  private async createNote(title: string, markdown: string): Promise<TwentyRecord> {
    try {
      const body = await this.request('POST', '/rest/notes', {
        title,
        bodyV2: { markdown },
      });
      return this.unwrap(body, 'note', 'createNote');
    } catch (err) {
      this.log.warn(`create note bodyV2 failed, retrying body: ${(err as Error).message}`);
      const body = await this.request('POST', '/rest/notes', { title, body: markdown });
      return this.unwrap(body, 'note', 'createNote');
    }
  }

  private async createNoteTarget(
    noteId: string,
    target: { opportunityId?: string; companyId?: string; personId?: string },
  ): Promise<void> {
    const attempts: Record<string, string>[] = [];
    if (target.opportunityId) {
      attempts.push({ noteId, targetOpportunityId: target.opportunityId });
      attempts.push({ noteId, opportunityId: target.opportunityId });
    }
    if (target.companyId) {
      attempts.push({ noteId, targetCompanyId: target.companyId });
      attempts.push({ noteId, companyId: target.companyId });
      attempts.push({ noteId, targetCompany: target.companyId });
    }
    if (target.personId) {
      attempts.push({ noteId, targetPersonId: target.personId });
      attempts.push({ noteId, personId: target.personId });
    }
    let lastErr: Error | undefined;
    for (const payload of attempts) {
      try {
        await this.request('POST', '/rest/noteTargets', payload);
        return;
      } catch (err) {
        lastErr = err as Error;
      }
    }
    this.log.warn(`noteTarget failed: ${lastErr?.message ?? 'unknown'}`);
  }

  private async createTask(title: string, status: string): Promise<TwentyRecord> {
    const body = await this.request('POST', '/rest/tasks', { title, status });
    return this.unwrap(body, 'task', 'createTask');
  }

  private async createTaskTarget(
    taskId: string,
    target: { opportunityId?: string; companyId?: string; personId?: string },
  ): Promise<void> {
    const attempts: Record<string, string>[] = [];
    if (target.opportunityId) {
      attempts.push({ taskId, targetOpportunityId: target.opportunityId });
      attempts.push({ taskId, opportunityId: target.opportunityId });
    }
    if (target.companyId) {
      attempts.push({ taskId, targetCompanyId: target.companyId });
      attempts.push({ taskId, companyId: target.companyId });
    }
    if (target.personId) {
      attempts.push({ taskId, targetPersonId: target.personId });
      attempts.push({ taskId, personId: target.personId });
    }
    for (const payload of attempts) {
      try {
        await this.request('POST', '/rest/taskTargets', payload);
        return;
      } catch {
        /* try next shape */
      }
    }
    this.log.warn('taskTarget failed for all payload shapes');
  }

  private noteMarkdown(note: TwentyRecord): string {
    const bodyV2 = note.bodyV2 as { markdown?: string } | undefined;
    if (bodyV2?.markdown) {
      return bodyV2.markdown;
    }
    if (typeof note.body === 'string') {
      return note.body;
    }
    return JSON.stringify(note.body ?? '');
  }

  private unwrap(body: unknown, singular: string, createKey?: string): TwentyRecord {
    const data = (body as { data?: Record<string, unknown> })?.data ?? body;
    if (!data || typeof data !== 'object') {
      throw new Error(`Unexpected Twenty payload for ${singular}`);
    }
    const record = data as Record<string, unknown>;
    const created = createKey ? record[createKey] : undefined;
    const named = record[singular];
    const inner = (created ?? named ?? record) as TwentyRecord;
    if (!inner || typeof inner !== 'object') {
      throw new Error(`Could not unwrap ${singular}`);
    }
    return inner;
  }

  private unwrapList(body: unknown, plural: string): TwentyRecord[] {
    const data = (body as { data?: Record<string, unknown> })?.data ?? body;
    if (Array.isArray(data)) {
      return data as TwentyRecord[];
    }
    if (data && typeof data === 'object') {
      const list = (data as Record<string, unknown>)[plural];
      if (Array.isArray(list)) {
        return list as TwentyRecord[];
      }
    }
    return [];
  }

  private async request(method: HttpMethod, path: string, payload?: unknown): Promise<unknown> {
    if (!this.cfg.twentyApiKey) {
      throw new Error('TWENTY_API_KEY is not set');
    }
    const url = `${this.cfg.twentyBaseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.twentyApiKey}`,
        'Content-Type': 'application/json',
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    if (!res.ok) {
      throw new Error(`Twenty ${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
    }
    return json;
  }
}
