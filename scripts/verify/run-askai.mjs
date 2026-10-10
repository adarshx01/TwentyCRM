import { session } from './twenty.mjs';
import { askAi, summarize } from './askai.mjs';
// usage: TWENTY_URL=http://localhost:3000 node scripts/verify/run-askai.mjs sam "Create a new lead: …"
const who = process.argv[2] ?? 'sam';
const text = process.argv.slice(3).join(' ');
const creds = { sam: ['sam@demo.local', process.env.TWENTY_TEST_SAM_PASSWORD], admin: ['admin@crmbee.local', process.env.TWENTY_ADMIN_PASSWORD], beth: ['beth@clientb.local', process.env.TWENTY_TEST_BETH_PASSWORD], bob: ['bob@clientb.local', process.env.TWENTY_TEST_BOB_PASSWORD] }[who];
const s = await session(...creds);
if (s.error) { console.log('login failed:', s.error); process.exit(1); }
console.log(summarize(await askAi(s.token, text)));
