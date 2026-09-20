import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { closedStage, idempotencyKey, outreachFooter } from '../common/domain';
import { loadConfig } from '../config/app.config';
import { ComposeService } from '../compose/compose.service';
import { MailService } from '../mail/mail.service';
import { ResearchService } from '../research/research.service';
import { TwentyClient, type TwentyRecord } from '../twenty/twenty.client';
import {
  boolValue,
  companyDomain,
  companyWebsite,
  personName,
  primaryEmail,
  relationId,
  selectValue,
} from '../twenty/record';

export type OutreachJobData = {
  opportunityId?: string;
  personId?: string;
  source: 'manual' | 'webhook';
};

export type OutreachJobResult = {
  status: 'drafted' | 'sent' | 'skipped' | 'failed';
  reason?: string;
  opportunityId?: string;
};

@Injectable()
export class OutreachService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(OutreachService.name);
  private queue: Queue<OutreachJobData> | null = null;
  private worker: Worker<OutreachJobData, OutreachJobResult> | null = null;
  private redis: IORedis | null = null;

  constructor(
    private readonly twenty: TwentyClient,
    private readonly research: ResearchService,
    private readonly compose: ComposeService,
    private readonly mail: MailService,
  ) {}

  async onModuleInit(): Promise<void> {
    const cfg = loadConfig();
    this.redis = new IORedis(cfg.redisUrl, {
      maxRetriesPerRequest: null,
      // Dual-stack: Railway private DNS is often IPv6 (`family=0`).
      family: 0,
    });
    this.queue = new Queue('rb-outreach', { connection: this.redis });
    this.worker = new Worker<OutreachJobData, OutreachJobResult>(
      'rb-outreach',
      (job) => this.process(job),
      { connection: this.redis, concurrency: 2 },
    );
    this.worker.on('failed', (job, err) => {
      this.log.error(`Job ${job?.id} failed: ${err.message}`);
    });
    this.log.log(`Outreach queue connected at ${cfg.redisUrl}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.redis?.disconnect();
  }

  async enqueue(data: OutreachJobData): Promise<{ jobId: string }> {
    if (!this.queue) {
      throw new ServiceUnavailableException('Outreach queue is not ready');
    }
    const job = await this.queue.add('run', data, {
      removeOnComplete: 100,
      attempts: 3,
      backoff: { type: 'exponential', delay: 4000 },
    });
    return { jobId: String(job.id) };
  }

  private async process(job: Job<OutreachJobData>): Promise<OutreachJobResult> {
    const opportunity = await this.resolveOpportunity(job.data);
    const opportunityId = String(opportunity.id);
    const step = Number(opportunity.sequenceStep ?? 1) || 1;
    const key = idempotencyKey(opportunityId, step);
    const mode = (selectValue(opportunity.outreachMode) ?? 'DRAFT').toUpperCase();
    const stage = String(opportunity.stage ?? '');

    if (boolValue(opportunity.stopOutreach) || closedStage(stage)) {
      await this.twenty.upsertOutreachJob({
        name: key,
        opportunityId,
        status: 'SKIPPED',
        mode,
        sequenceStep: step,
        lastError: 'stop condition',
        idempotencyKey: key,
      });
      return { status: 'skipped', reason: 'stop condition', opportunityId };
    }

    const existing = await this.twenty.findExistingOutreach(opportunityId, step);
    if (existing) {
      this.log.log(`Skip ${key}: draft/sent note already exists`);
      return { status: 'skipped', reason: 'already drafted', opportunityId };
    }

    const companyId = relationId(opportunity.companyId) ?? relationId(opportunity.company);
    const personId =
      relationId(opportunity.pointOfContactId) ?? relationId(opportunity.pointOfContact);
    const company = companyId ? await this.twenty.getCompany(companyId) : null;
    const person = personId ? await this.twenty.getPerson(personId) : null;

    await this.twenty.upsertOutreachJob({
      name: key,
      opportunityId,
      status: 'RESEARCHING',
      mode,
      sequenceStep: step,
      idempotencyKey: key,
    });

    const research = await this.research.research({
      website: companyWebsite(company),
      domainName: companyDomain(company),
      email: primaryEmail(person),
      companyName: String(company?.name ?? opportunity.name ?? 'the company'),
    });

    if (companyId && research.summary) {
      await this.twenty.patchCompany(companyId, { researchSummary: research.summary.slice(0, 8000) });
    }

    const { first } = personName(person);
    const draft = await this.compose.draft({
      companyName: String(company?.name ?? 'your team'),
      contactFirstName: first,
      buyerRole: selectValue(person?.buyerRole) ?? (typeof person?.jobTitle === 'string' ? person.jobTitle : null),
      solutionInterest: selectValue(opportunity.solutionInterest),
      researchSummary: research.summary,
      host: research.host,
    });

    const autoRequested = mode === 'AUTO';
    const to = primaryEmail(person);
    const sendResult = await this.mail.send({
      to: to ?? '',
      draft,
      autoRequested: Boolean(autoRequested && to),
    });

    const sent = sendResult.sent;
    const status = sent ? 'sent' : 'draft';
    const titlePrefix = sent ? 'Outreach sent' : 'Outreach draft';
    const date = new Date().toISOString().slice(0, 10);
    const markdown = [
      `**Subject:** ${draft.subject}`,
      '',
      draft.bodyText,
      '',
      `**Why this angle:** ${draft.whyThisAngle}`,
      research.fetched ? `**Source:** ${research.url}` : '**Source:** fetch fallback',
      sendResult.skippedReason ? `**Send:** ${sendResult.skippedReason}` : '',
      outreachFooter({ opportunityId, step, status }),
    ]
      .filter((line) => line !== '')
      .join('\n');

    await this.twenty.createLinkedNote({
      title: `${titlePrefix} — ${date}`,
      markdown,
      opportunityId,
      companyId,
      personId,
    });

    if (!sent) {
      await this.twenty.createReviewTask({ opportunityId, companyId, personId });
    }

    if (sent && /^new$/i.test(stage)) {
      await this.twenty.patchOpportunity(opportunityId, { stage: 'CONTACTED' });
    }

    await this.twenty.patchOpportunity(opportunityId, {
      lastOutreachKey: `${step}:${status}`,
    });

    await this.twenty.upsertOutreachJob({
      name: key,
      opportunityId,
      status: sent ? 'SENT' : 'DRAFTED',
      mode,
      sequenceStep: step,
      idempotencyKey: key,
    });

    return { status: sent ? 'sent' : 'drafted', opportunityId };
  }

  private async resolveOpportunity(data: OutreachJobData): Promise<TwentyRecord> {
    if (data.opportunityId) {
      return this.twenty.getOpportunity(data.opportunityId);
    }
    if (data.personId) {
      const found = await this.twenty.findOpenOpportunityForPerson(data.personId);
      if (!found) {
        throw new Error(`No opportunity found for person ${data.personId}`);
      }
      return found;
    }
    throw new Error('opportunityId or personId is required');
  }
}
