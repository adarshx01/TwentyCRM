import { defineLogicFunction } from 'twenty-sdk/define';

import { FN_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { createBeeClient } from 'src/lib/bee-client';

type Params = { message?: string; buttonId?: string };

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
  const replies = params.buttonId ? await bee.pressButton(params.buttonId) : params.message ? await bee.sendText(params.message) : [];
  if (!replies.length) return { replies: [], note: 'Bee has not replied yet. Ask the user to check again in a moment.' };
  return {
    replies: replies.map((m) => ({ text: m.text, buttons: m.buttons ?? [] })),
    instructions: 'Show each reply text to the user as written. If a reply has buttons, present them as options; when the user picks one, call this tool again with that button id as buttonId (not message).',
  };
};

export default defineLogicFunction({
  universalIdentifier: FN_UNIVERSAL_IDENTIFIER,
  name: 'ask-bee',
  description:
    'Hand a sales request to Bee, the CRM capture assistant: create or update leads/contacts/companies/opportunities, log meeting notes, schedule follow-ups, find records, and ask for digests or pipeline reports. Bee prepares a draft and nothing is saved until the user confirms with its Confirm button.',
  timeoutSeconds: 60,
  handler,
  toolTriggerSettings: {
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: "The user's request, in their own words (do not rewrite or summarise it)." },
        buttonId: { type: 'string', description: 'Id of a Bee button the user chose (for example Confirm or Cancel on a draft). Use instead of message.' },
      },
    },
  },
});
