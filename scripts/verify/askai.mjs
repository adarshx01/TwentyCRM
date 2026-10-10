// Drive Twenty's built-in Ask AI as a signed-in user through its API (create thread → send → read reply).
import { randomUUID } from 'node:crypto';
import { gql, session } from './twenty.mjs';
export async function askAi(token, text, { waitMs = 120000 } = {}) {
  const t = await gql(`mutation { createChatThread { id } }`, {}, token);
  if (t.errors) return { error: 'createChatThread: ' + t.errors[0].message };
  const threadId = t.data.createChatThread.id;
  const s = await gql(`mutation($t:UUID!,$x:String!,$m:UUID!){ sendChatMessage(threadId:$t,text:$x,messageId:$m){ queued messageId streamId } }`, { t: threadId, x: text, m: randomUUID() }, token);
  if (s.errors) return { error: 'sendChatMessage: ' + s.errors[0].message };
  const start = Date.now(); let last = null;
  while (Date.now() - start < waitMs) {
    await new Promise((r) => setTimeout(r, 2500));
    const m = await gql(`query($t:UUID!){ chatMessages(threadId:$t){ role parts { type textContent toolName toolInput toolOutput state errorMessage } } }`, { t: threadId }, token);
    if (m.errors) return { error: 'chatMessages: ' + m.errors[0].message };
    const msgs = m.data.chatMessages; last = msgs;
    const asst = msgs.filter((x) => x.role === 'assistant');
    const done = asst.length && asst[asst.length - 1].parts.some((p) => p.type === 'text' && p.state === 'done' && p.textContent);
    const th = await gql(`query($i:UUID!){ chatThread(id:$i){ activeStreamId } }`, { i: threadId }, token);
    if (done && !th.data?.chatThread?.activeStreamId) break;
  }
  return { threadId, messages: last };
}
export const summarize = (r) => {
  if (r.error) return r.error;
  const parts = r.messages.flatMap((m) => m.parts.map((p) => ({ role: m.role, ...p })));
  const tools = parts.filter((p) => p.toolName).map((p) => `${p.toolName}(${JSON.stringify(p.toolInput ?? {}).slice(0, 120)}) -> ${JSON.stringify(p.toolOutput ?? p.errorMessage ?? '').slice(0, 260)}`);
  const text = parts.filter((p) => p.role === 'assistant' && p.type === 'text').map((p) => p.textContent).join('\n');
  return `TOOLS:\n  ${tools.join('\n  ') || '(none)'}\nREPLY:\n${text}`;
};
