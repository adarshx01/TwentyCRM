import { defineApplication } from 'twenty-sdk/define';

import {
  APP_UNIVERSAL_IDENTIFIER,
  VAR_TOKEN_UNIVERSAL_IDENTIFIER,
  VAR_TWENTY_URL_UNIVERSAL_IDENTIFIER,
  VAR_URL_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

export default defineApplication({
  universalIdentifier: APP_UNIVERSAL_IDENTIFIER,
  displayName: 'CRM Bee',
  description: 'Chat with Bee inside Twenty: capture leads, log activity and ask about your pipeline. Records stay in Twenty.',
  applicationVariables: {
    BEE_API_URL: {
      universalIdentifier: VAR_URL_UNIVERSAL_IDENTIFIER,
      label: 'Bee API URL',
      description: 'Base URL of the CRM Bee API, reachable from the Twenty server.',
      value: 'http://host.docker.internal:3400',
      isSecret: false,
      isRequired: true,
    },
    TWENTY_INTERNAL_URL: {
      universalIdentifier: VAR_TWENTY_URL_UNIVERSAL_IDENTIFIER,
      label: 'Twenty internal URL',
      description: 'How the function runner reaches the Twenty server (the worker container cannot use localhost).',
      value: 'http://server:3000',
      isSecret: false,
      isRequired: true,
    },
    BEE_CHAT_TOKEN: {
      universalIdentifier: VAR_TOKEN_UNIVERSAL_IDENTIFIER,
      label: 'Bee chat token',
      description: 'Shared secret (CRM_CHAT_TOKEN in the Bee API).',
      isSecret: true,
      isRequired: true,
    },
  },
});
