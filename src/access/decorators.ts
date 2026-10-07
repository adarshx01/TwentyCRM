import { SetMetadata } from '@nestjs/common';
import type { Permission } from './permissions';

export const PERMISSIONS_KEY = 'requiredPermissions';
export const IS_TWENTY_APP_KEY = 'isTwentyApp';

/** The live actor must hold EVERY listed permission (checked by PermissionGuard against ROLE_MATRIX). */
export const RequirePermission = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Called by the CRM Bee app inside Twenty (a server-side logic function). Authenticated with the tenant's own app
 * secret plus the caller's Twenty workspace member, which must be linked to an active Bee user (ActorGuard).
 */
export const TwentyApp = () => SetMetadata(IS_TWENTY_APP_KEY, true);

export const ALLOW_UNLINKED_KEY = 'allowUnlinkedMember';
/** A @TwentyApp route an unlinked Twenty member may call (only "who am I" style routes). */
export const AllowUnlinkedMember = () => SetMetadata(ALLOW_UNLINKED_KEY, true);
