import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { IS_PUBLIC_KEY, IS_WEBHOOK_KEY, IS_ADMIN_KEY } from '../guards/auth.guard';
import { ROLES_KEY } from '../guards/roles.guard';
import type { UserRole } from '../../database/schema';

/** Mark a route as public — no authentication required */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Mark a route as a webhook — uses provider-specific auth */
export const Webhook = () => SetMetadata(IS_WEBHOOK_KEY, true);

/** Mark a route as admin-only — requires admin API key */
export const AdminOnly = () => SetMetadata(IS_ADMIN_KEY, true);

/** Restrict route to specific roles */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** The live, authorized actor (tenant + user + role) for the request. */
export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().actor);
