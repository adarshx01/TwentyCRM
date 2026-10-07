import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { IdentityService } from '../../identity/identity.service';
import type { TenantContext, UserContext } from '../types';
import { M } from '../../observability/metrics';

export const IS_PUBLIC_KEY = 'isPublic';
export const IS_WEBHOOK_KEY = 'isWebhook';
export const IS_ADMIN_KEY = 'isAdmin';

export interface TokenPayload { userId: string; tenantId: string; role?: string; iat?: number; exp?: number }
export interface Actor { tenant: TenantContext; user: UserContext }

const safeEq = (a: string, b: string): boolean => {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Authentication guard. Routes are authenticated by default:
 *  - @Public()    health checks and webhooks (webhooks verify provider signatures themselves)
 *  - @AdminOnly() platform-operator API key (constant-time comparison)
 *  - default      HS256 JWT carrying tenant + user claims
 * A token only NAMES a user; ActorGuard re-reads the live user, tenant and role on every request,
 * so revocation and role changes apply immediately (IAM-05).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const flag = (key: string) => this.reflector.getAllAndOverride<boolean>(key, [ctx.getHandler(), ctx.getClass()]);
    if (flag(IS_PUBLIC_KEY) || flag(IS_WEBHOOK_KEY)) return true;
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { token?: TokenPayload; isAdmin?: boolean }>();
    if (flag(IS_ADMIN_KEY)) {
      const key = req.headers['x-api-key'];
      if (typeof key !== 'string' || !safeEq(key, this.config.security.adminApiKey)) { M.webhookAuthFailures().inc({ channel: 'admin', reason: 'api_key' }); throw new UnauthorizedException('Invalid admin API key'); }
      req.isAdmin = true;
      return true;
    }
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
    if (!safeEq(expected, parts[2])) return null;
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

/** Loads the live actor (tenant, user, role) for authenticated user routes. */
@Injectable()
export class ActorGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly identity: IdentityService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { token?: TokenPayload; actor?: Actor; user?: unknown }>();
    if (!req.token) return true; // public, webhook or admin route
    const live = await this.identity.getActiveUser(req.token.tenantId, req.token.userId);
    if (!live) throw new UnauthorizedException('Access has been revoked');
    req.actor = live;
    req.user = { userId: live.user.userId, tenantId: live.user.tenantId, role: live.user.role };
    return true;
  }
}
