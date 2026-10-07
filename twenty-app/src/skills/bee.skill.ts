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
- Bee replies with a draft or a numbered question. Show its text exactly, including warnings. Nothing is saved until the user replies Confirm.
- Whatever the user says next while a Bee conversation is open ("1", "2", "confirm", "cancel", a correction such as "phone +91…") goes to ask-bee verbatim as message. Never answer a Bee question yourself and never call the tool with anything but the user's own words.
- Do not invent details Bee did not return.`,
});
