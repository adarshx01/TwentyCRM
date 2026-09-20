import { parseDraftJson } from './llm-json';

describe('parseDraftJson', () => {
  it('parses a JSON object', () => {
    const draft = parseDraftJson(
      '{"subject":"Hi","bodyText":"Hello there","whyThisAngle":"hiring"}',
    );
    expect(draft.subject).toBe('Hi');
    expect(draft.bodyText).toBe('Hello there');
  });

  it('strips markdown fences', () => {
    const draft = parseDraftJson(
      '```json\n{"subject":"A","bodyText":"B","whyThisAngle":"C"}\n```',
    );
    expect(draft.subject).toBe('A');
  });

  it('rejects incomplete payloads', () => {
    expect(() => parseDraftJson('{"subject":"only"}')).toThrow(/missing/i);
  });
});
