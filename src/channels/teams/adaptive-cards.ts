import type { ChannelReply } from '../channel.types';

/** WhatsApp-style *bold* → Teams markdown **bold**. */
const md = (t: string) => t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/g, '$1**$2**');

/** Render a channel-neutral reply as an Adaptive Card with Submit actions (TM-04). */
export function replyToCard(reply: ChannelReply): Record<string, unknown> {
  if (reply.card) {
    const card = reply.card as { actions?: unknown[] };
    return reply.buttons?.length && !card.actions ? { ...reply.card, actions: reply.buttons.map(toAction) } : reply.card;
  }
  return {
    type: 'AdaptiveCard', version: '1.4', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    body: [{ type: 'TextBlock', text: md(reply.text), wrap: true }],
    ...(reply.buttons?.length ? { actions: reply.buttons.map(toAction) } : {}),
  };
}

const toAction = (b: { id: string; title: string; style?: string }) => ({
  type: 'Action.Submit', title: b.title, data: { id: b.id }, ...(b.style === 'primary' ? { style: 'positive' } : b.style === 'danger' ? { style: 'destructive' } : {}),
});

export const CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';
