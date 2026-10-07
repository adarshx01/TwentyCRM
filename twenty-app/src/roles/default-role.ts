import { defineApplicationRole, STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS } from 'twenty-sdk/define';

import { ROLE_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';

// Least privilege: the app's functions only look up the signed-in workspace member (who is calling).
// CRM records are read and written by the Bee service with its own workspace key, under Bee's scope rules.
export default defineApplicationRole({
  universalIdentifier: ROLE_UNIVERSAL_IDENTIFIER,
  label: 'CRM Bee app',
  description: 'Identifies the signed-in workspace member for Bee. No access to CRM records.',
  canReadAllObjectRecords: false,
  canUpdateAllObjectRecords: false,
  canSoftDeleteAllObjectRecords: false,
  canDestroyAllObjectRecords: false,
  canUpdateAllSettings: false,
  objectPermissions: [
    {
      objectUniversalIdentifier: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.workspaceMember.universalIdentifier,
      canReadObjectRecords: true,
      canUpdateObjectRecords: false,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
  ],
});
