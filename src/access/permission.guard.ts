import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from './decorators';
import { can, type Permission } from './permissions';
import type { Actor } from '../common/guards/auth.guard';

/** Global, last in the chain: enforces @RequirePermission against the LIVE role loaded by ActorGuard. */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required?.length) return true;
    const actor = ctx.switchToHttp().getRequest<{ actor?: Actor }>().actor;
    if (!actor) throw new ForbiddenException('This action needs a signed-in employee.');
    const missing = required.filter((p) => !can(actor.user.role, p));
    if (missing.length) throw new ForbiddenException('Your role does not allow this action.');
    return true;
  }
}
