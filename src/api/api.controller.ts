import { Body, Controller, Get, Headers, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { CurrentActor, RequirePermission } from '../common/decorators';
import type { Actor } from '../common/guards/auth.guard';
import { ConfirmationService } from '../conversation/confirmation.service';
import { ConversationService } from '../conversation/conversation.service';
import { DraftService } from '../conversation/draft.service';
import { OperationJournal } from '../crm/operations/operation-journal.service';
import { OperationEffects } from '../crm/operations/operation-effects.service';
import { IntakeService } from '../intake/intake.service';
import type { DraftData } from '../conversation/draft.types';
import { can } from '../access/permissions';

const ConfirmBody = z.object({ version: z.number().int().positive(), hash: z.string().regex(/^[0-9a-f]{8,64}$/) }).strict();
const EditBody = z.object({ text: z.string().min(1).max(2000) }).strict();
const ApproveBody = z.object({ corrections: z.object({ name: z.string().max(200).optional(), email: z.string().max(200).optional(), phone: z.string().max(40).optional(), company: z.string().max(200).optional(), message: z.string().max(5000).optional() }).strict().optional() }).strict();

/**
 * Employee-facing API. The actor comes from a verified token plus a live DB read; the tenant is
 * never taken from the request body or URL. Cross-tenant IDs resolve to 404 (RLS + tenant scoping).
 */
@Controller()
export class ApiController {
  constructor(
    private readonly confirmation: ConfirmationService,
    private readonly conversation: ConversationService,
    private readonly drafts: DraftService,
    private readonly journal: OperationJournal,
    private readonly intake: IntakeService,
  ) {}

  @Get('drafts/:id')
  async getDraft(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    const d = await this.drafts.get(a.tenant.tenantId, id);
    if (!d || d.userId !== a.user.userId) throw new NotFoundException('Draft not found');
    const data = d.extractedData as unknown as DraftData;
    return { id: d.id, state: d.state, version: d.version, hash: d.contentHash?.slice(0, 8) ?? null, expiresAt: d.expiresAt, operationId: d.operationId, kind: data?.kind };
  }

  @Post('drafts/:id/confirm') @HttpCode(200)
  async confirm(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    if (!key || key.length < 8 || key.length > 200) throw new BadRequestException('Idempotency-Key header (8-200 chars) is required');
    const b = ConfirmBody.parse(body);
    const r = await this.confirmation.confirm({ tenant: a.tenant, user: a.user, draftId: id, version: b.version, hash: b.hash, idempotencyKey: `api:${key}` });
    switch (r.status) {
      case 'started': case 'duplicate': return { status: r.status === 'started' ? 'committing' : 'already_confirmed', operationId: r.operationId, reference: OperationEffects.reference(r.operationId) };
      case 'not_found': throw new NotFoundException('Draft not found');
      case 'stale': case 'record_changed': return { status: 'stale', message: 'The preview is out of date; re-read the draft and confirm the current version.' };
      case 'rejected': return { status: 'rejected', message: r.message };
      default: return { status: r.status };
    }
  }

  @Post('drafts/:id/edit') @HttpCode(200)
  async edit(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const r = await this.conversation.apiEdit(a.tenant, a.user, id, EditBody.parse(body).text);
    if (!r.ok && r.message === 'Draft not found.') throw new NotFoundException('Draft not found');
    return r; // no CRM mutation happens until confirmation (§9)
  }

  @Post('drafts/:id/cancel') @HttpCode(200)
  async cancel(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.conversation.apiCancel(a.tenant, a.user, id);
    if (r === 'not_found') throw new NotFoundException('Draft not found');
    return { status: r };
  }

  @Get('operations/:id')
  async operation(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    const op = await this.journal.get(a.tenant.tenantId, id);
    // Employees see their own operations; CXOs and client admins see the workspace's (scoped progress, safe errors only).
    if (!op || (op.userId !== a.user.userId && !can(a.user.role, 'operations.read.all'))) throw new NotFoundException('Operation not found');
    const p = OperationJournal.describeProgress(op);
    return { id: op.id, reference: OperationEffects.reference(op.id), type: op.type, state: op.state, saved: p.saved, pending: p.pending, failed: p.failed, result: op.state === 'committed' ? op.result : undefined, error: op.state === 'failed' || op.state === 'needs_repair' ? { message: (op.errorInfo as any)?.message ?? 'The operation could not be completed.' } : undefined, createdAt: op.createdAt, updatedAt: op.updatedAt };
  }

  // ── intake review (IN-11) ───────────────────────────────────
  @Get('intake/review') @RequirePermission('intake.review')
  async listReview(@CurrentActor() a: Actor, @Query('state') state?: string) {
    const rows = await this.intake.listReview(a.tenant.tenantId, state === 'failed' ? 'failed' : 'review', reviewer(a));
    return rows.map((r) => ({ id: r.id, state: r.state, reason: r.reviewReason, sourceId: r.sourceId, fields: sanitizeFields(r.parsedFields), receivedAt: r.createdAt }));
  }

  @Post('intake/review/:id/approve') @RequirePermission('intake.review') @HttpCode(200)
  async approve(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = ApproveBody.parse(body ?? {});
    const r = await this.intake.approve(a.tenant.tenantId, id, reviewer(a), b.corrections ?? {});
    return { id: r.id, state: r.state, operationId: r.operationId };
  }

  @Post('intake/review/:id/reject') @RequirePermission('intake.review') @HttpCode(200)
  async reject(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.intake.reject(a.tenant.tenantId, id, reviewer(a));
    return { id: r.id, state: r.state };
  }
}

const reviewer = (a: Actor) => ({ id: a.user.userId, role: a.user.role, managedTeamIds: a.user.managedTeamIds });

function sanitizeFields(f: unknown): Record<string, unknown> {
  const { _meta, _fingerprint, ...rest } = (f ?? {}) as Record<string, unknown>;
  return rest;
}
