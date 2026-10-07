import { defineSkill } from 'twenty-sdk/define';

import { SKILL_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';

export default defineSkill({
  universalIdentifier: SKILL_UNIVERSAL_IDENTIFIER,
  name: 'bee-crm-capture',
  label: 'Bee CRM capture',
  description: 'Capture leads, log activity, schedule follow-ups and report on the pipeline through Bee.',
  icon: 'IconMessageChatbot',
  content: `Use the ask-bee tool for any sales-capture or pipeline request: adding or updating a lead, contact, company or opportunity, logging a meeting or call, scheduling a follow-up or task, finding a contact, "who should I meet today", overdue follow-ups, team pipeline or won/lost summaries.
- Pass the user's words unchanged as message. Do not create or edit those records yourself with other tools.
- Bee replies with a draft. Show it exactly, including its warnings, and offer its buttons (Confirm / Edit / Cancel). Nothing is saved until the user confirms.
- When the user confirms, cancels or edits, call ask-bee again with the matching buttonId (or their edit as message).
- Do not invent details Bee did not return.`,
});
