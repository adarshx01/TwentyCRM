import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { TwentyApp } from '../common/decorators';
import type { OperatorPrincipal } from '../access/operator.service';
import { UserFacingError } from '../common/errors';
import { CompanyProvisioner } from './company-provisioner.service';
import { PlatformService } from './platform.service';

type Req = { operator?: OperatorPrincipal };
const opOf = (req: Req): OperatorPrincipal => {
  if (!req.operator) throw new ForbiddenException('Platform operators only.');
  return req.operator;
};
const Reason = z.object({ reason: z.string().max(500).optional() }).strict();
const Support = z.object({ reason: z.string().min(10).max(2000), hours: z.number().int().min(1).max(72).default(4) }).strict();
const NewOperator = z.object({ name: z.string().min(2).max(120), email: z.string().email() }).strict();

/**
 * The Platform console API (BRD §4: platform operators provision and operate tenants). Reached from the Bee page in the
 * YlogX operations workspace; authenticated as a named operator. It exposes companies and their health, never their
 * CRM records or messages.
 */
@Controller('v1/platform')
@TwentyApp()
export class PlatformController {
  constructor(private readonly platform: PlatformService, private readonly provisioner: CompanyProvisioner) {}

  @Get('health')
  health(@Req() req: Req) { opOf(req); return this.platform.health(); }

  @Get('companies')
  companies(@Req() req: Req) { opOf(req); return this.platform.companies(); }

  @Get('companies/in-progress')
  inProgress(@Req() req: Req) { opOf(req); return this.provisioner.list(); }

  /** Starts the creation and returns at once (Twenty gives app routes 20 s); poll `companies/in-progress`. */
  @Post('companies') @HttpCode(202)
  create(@Req() req: Req, @Body() body: unknown) { return this.provisioner.start(body, opOf(req)); }

  @Get('companies/:id')
  company(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string) { opOf(req); return this.platform.company(id); }

  @Post('companies/:id/:action') @HttpCode(200)
  async action(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Param('action') action: string, @Body() body: unknown) {
    const op = opOf(req);
    switch (action) {
      case 'suspend': return this.platform.setStatus(id, 'suspended', op, Reason.parse(body ?? {}).reason);
      case 'reactivate': return this.platform.setStatus(id, 'active', op, Reason.parse(body ?? {}).reason);
      case 'resync': return this.platform.resync(id, op);
      case 'configure-app': return this.platform.configureApp(id, op);
      case 'upgrade-app': return this.platform.upgradeApp(id, op);
      case 'support-request': { const b = Support.parse(body); return this.platform.requestSupport(id, op, b.reason, b.hours); }
      default: throw new UserFacingError('Unknown action.', 'NOT_FOUND');
    }
  }

  @Get('companies/:id/audit')
  audit(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Query('limit') limit?: string) { return this.platform.companyAudit(id, opOf(req), Number(limit) || 50); }

  @Get('operators')
  operators(@Req() req: Req) { opOf(req); return this.platform.listOperators(); }

  @Post('operators') @HttpCode(201)
  addOperator(@Req() req: Req, @Body() body: unknown) { return this.platform.addOperator(NewOperator.parse(body), opOf(req)); }

  @Post('operators/:id/revoke') @HttpCode(200)
  revokeOperator(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string) { return this.platform.revokeOperator(id, opOf(req)); }

  @Get('audit')
  platformAudit(@Req() req: Req, @Query('limit') limit?: string) { opOf(req); return this.platform.recentAudit(Number(limit) || 100); }
}
