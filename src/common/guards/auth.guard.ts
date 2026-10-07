import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHmac } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { IdentityService } from '../../identity/identity.service';
import { TenantService } from '../../tenant/tenant.service';
import { OperatorService, type OperatorPrincipal } from '../../access/operator.service';
import { ALLOW_UNLINKED_KEY, IS_TWENTY_APP_KEY } from '../../access/decorators';
import { safeEqual, tenantAppSecret } from '../../access/app-secret';
import type { TenantContext, UserContext } from '../types';
import { M } from '../../observability/metrics';

export const IS_PUBLIC_KEY = 'isPublic';
export const IS_WEBHOOK_KEY = 'isWebhook';
export const IS_ADMIN_KEY = 'isAdmin';

export interface TokenPayload { userId: string; tenantId: string; role?: string; iat?: number; exp?: number }
export interface Actor { tenant: TenantContext; user: UserContext }
/** The Twenty member behind a Twenty-app call (set even when the member is not linked yet). */
export interface TwentyCaller { tenant: TenantContext; workspaceId: string; memberId: string; linked: boolean }

type Req = FastifyRequest & { token?: TokenPayload; actor?: Actor; operator?: OperatorPrincipal; twenty?: TwentyCaller; user?: unknown };

const WS_HEADER = 'x-bee-workspace';
const MEMBER_HEADER = 'x-bee-member';
const UUIDISH = /^[0-9a-zA-Z-]{8,64}$/;

/**
 * Authentication (who is calling). Routes are authenticated by default:
 *  - @Public() / @Webhook()  health checks and provider webhooks (webhooks verify signatures themselves)
 *  - @AdminOnly()            platform plane: a named operator key, or the bootstrap key (break-glass)
 *  - @TwentyApp()            the CRM Bee app inside Twenty: the tenant's own app secret + the Twenty member;
 *                            without the Twenty headers these routes also accept an employee JWT
 *  - default                 employee HS256 JWT carrying tenant + user claims
 * A credential only NAMES a principal; ActorGuard re-reads the live user, tenant and role on every request (IAM-05).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly operators: OperatorService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const flag = (key: string) => this.reflector.getAllAndOverride<boolean>(key, [ctx.getHandler(), ctx.getClass()]);
    if (flag(IS_PUBLIC_KEY) || flag(IS_WEBHOOK_KEY)) return true;
    const req = ctx.switchToHttp().getRequest<Req>();
    if (flag(IS_ADMIN_KEY)) {
      const key = req.headers['x-api-key'];
      const op = await this.operators.authenticate(typeof key === 'string' ? key : undefined);
      if (!op) { M.webhookAuthFailures().inc({ channel: 'admin', reason: 'api_key' }); throw new UnauthorizedException('Invalid operator key'); }
      req.operator = op;
      return true;
    }
    if (flag(IS_TWENTY_APP_KEY) && req.headers[WS_HEADER]) return true; // authenticated by ActorGuard (needs the tenant registry)
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing or invalid authorization header');
    const payload = verifyToken(header.slice(7), this.config.security.jwtSecret);
    if (!payload) throw new UnauthorizedException('Invalid or expired token');
    req.token = payload;
    return true;
  }
}

export function verifyToken(token: string, secret: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (header.alg !== 'HS256') return null; // never accept 'none' or other algorithms
    const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
    if (!safeEqual(expected, parts[2])) return null;
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as TokenPayload;
    if (!p.exp || p.exp * 1000 < Date.now() || !p.userId || !p.tenantId) return null;
    return p;
  } catch { return null; }
}

export function generateToken(payload: { userId: string; tenantId: string; role?: string }, secret: string, expiresInSeconds = 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + expiresInSeconds })).toString('base64url');
  return `${header}.${body}.${createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')}`;
}

/** Loads the live actor (tenant, user, role) for employee routes; authenticates Twenty-app calls. */
@Injectable()
export class ActorGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: IdentityService,
    private readonly tenants: TenantService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Req>();
    const twentyApp = this.reflector.getAllAndOverride<boolean>(IS_TWENTY_APP_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (twentyApp && req.headers[WS_HEADER]) return this.twentyApp(req, ctx);
    if (!req.token) return true; // public, webhook or operator route
    const live = await this.identity.getActiveUser(req.token.tenantId, req.token.userId);
    if (!live) throw new UnauthorizedException('Access has been revoked');
    this.attach(req, live);
    return true;
  }

  private attach(req: Req, live: Actor): void {
    req.actor = live;
    req.user = { userId: live.user.userId, tenantId: live.user.tenantId, role: live.user.role };
  }

  /**
   * The app's logic function runs inside Twenty, which authenticated the member; it relays the workspace id and
   * member id with THAT tenant's app secret. A secret from another tenant fails here (tenantAppSecret is per tenant).
   */
  private async twentyApp(req: Req, ctx: ExecutionContext): Promise<boolean> {
    const master = this.config.web.token;
    if (!master) throw new UnauthorizedException('In-CRM access is not configured');
    const workspaceId = String(req.headers[WS_HEADER] ?? '');
    const memberId = String(req.headers[MEMBER_HEADER] ?? '');
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!UUIDISH.test(workspaceId) || !UUIDISH.test(memberId) || !bearer) throw new UnauthorizedException('Missing Twenty caller');
    const tenant = await this.tenants.findByWorkspace(workspaceId);
    if (!tenant || !safeEqual(bearer, tenantAppSecret(master, tenant.tenantId))) {
      M.webhookAuthFailures().inc({ channel: 'twenty-app', reason: 'secret' });
      throw new UnauthorizedException('Invalid app credentials');
    }
    const live = await this.identity.resolveTwentyMember(tenant.tenantId, memberId);
    req.twenty = { tenant, workspaceId, memberId, linked: !!live };
    if (live) { this.attach(req, live); return true; }
    // Unlinked members may only ask who they are (the page then says "ask your admin to link you").
    if (this.reflector.getAllAndOverride<boolean>(ALLOW_UNLINKED_KEY, [ctx.getHandler(), ctx.getClass()])) return true;
    throw new ForbiddenException('Your Twenty account is not linked to a Bee user yet. Ask a client admin to link you.');
  }
}

