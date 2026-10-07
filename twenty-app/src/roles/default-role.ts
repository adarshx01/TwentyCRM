import { defineApplicationRole } from 'twenty-sdk/define';

import { ROLE_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';

// The logic function only reads workspace members to learn the caller's email. Bee writes records through its own API key.
export default defineApplicationRole({
  universalIdentifier: ROLE_UNIVERSAL_IDENTIFIER,
  label: 'CRM Bee chat',
  description: 'Lets the Bee chat identify the signed-in workspace member.',
  canReadAllObjectRecords: true,
  canUpdateAllObjectRecords: false,
  canSoftDeleteAllObjectRecords: false,
  canDestroyAllObjectRecords: false,
});
