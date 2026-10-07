import { defineLogicFunction } from 'twenty-sdk/define';

import { FN_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { createBeeClient } from 'src/lib/bee-client';

type Params = { message?: string };

const handler = async (params: Params) => {
  try {
    return await run(params);
  } catch (e) {
    console.error('ask-bee failed', e);
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

const run = async (params: Params) => {
  const bee = await createBeeClient();
  const replies = params.message ? await bee.sendText(params.message) : [];
  if (!replies.length) return { replies: [], note: 'Bee has not replied yet. Ask the user to check again in a moment.' };
  return {
    replies: replies.map((m) => ({ text: m.text })),
    instructions: "Show each reply text to the user exactly as written. Bee understands the user's next words directly (a number for a numbered question, Confirm, Edit, Cancel), so relay them verbatim as message.",
  };
};

export default defineLogicFunction({
  universalIdentifier: FN_UNIVERSAL_IDENTIFIER,
  name: 'ask-bee',
  description:
    'Hand a sales request to Bee, the CRM capture assistant: create or update leads/contacts/companies/opportunities, log meeting notes, schedule follow-ups, find records, and ask for digests or pipeline reports. Bee prepares a draft and nothing is saved until the user confirms by replying Confirm.',
  timeoutSeconds: 60,
  handler,
  toolTriggerSettings: {
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: "The user's latest message, verbatim: a request, a number answering one of Bee's numbered questions, or Confirm / Edit / Cancel. Never reword it." },
      },
    },
  },
});
