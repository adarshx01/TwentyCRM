import { ComposeService } from './compose.service';

describe('ComposeService template', () => {
  it('includes a demo CTA and unsubscribe placeholder', () => {
    const draft = new ComposeService().template({
      companyName: 'Acme',
      contactFirstName: 'Rahul',
      solutionInterest: 'VOICEBOT',
      researchSummary: 'Title: Acme\nWe hire engineers at scale.',
      host: 'acme.com',
    });
    expect(draft.subject.toLowerCase()).toContain('acme');
    expect(draft.bodyText).toContain('Rahul');
    expect(draft.bodyText).toContain('{{unsubscribe}}');
    expect(draft.bodyText).toContain('recruitmentbricks.ai/request-a-demo');
  });
});
