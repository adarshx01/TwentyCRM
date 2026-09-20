import {
  closedStage,
  domainFromEmail,
  hostnameFromUrlOrHost,
  parseOutreachFooter,
} from './domain';

describe('domain helpers', () => {
  it('extracts host from a URL or bare domain', () => {
    expect(hostnameFromUrlOrHost('https://www.Acme.com/about')).toBe('acme.com');
    expect(hostnameFromUrlOrHost('acme.com')).toBe('acme.com');
  });

  it('does not treat consumer inboxes as company domains', () => {
    expect(domainFromEmail('rahul@gmail.com')).toBeNull();
    expect(domainFromEmail('rahul@acme.com')).toBe('acme.com');
  });

  it('detects closed stages including Twenty defaults', () => {
    expect(closedStage('CLOSED_WON')).toBe(true);
    expect(closedStage('WON')).toBe(true);
    expect(closedStage('NEW')).toBe(false);
  });

  it('parses the outreach footer', () => {
    const parsed = parseOutreachFooter(
      'hello\n<!-- rb-outreach:opportunity=abc-123:step=1:status=draft -->\n',
    );
    expect(parsed).toEqual({
      opportunityId: 'abc-123',
      step: 1,
      status: 'draft',
    });
  });
});
