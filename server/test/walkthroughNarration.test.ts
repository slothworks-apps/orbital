import { describe, it, expect } from 'vitest';
import { narrationFields, parseNarration } from '../src/walkthrough/narration.js';

const known = ['e1', 'e2', 'e3'];
const fence = (json: string) => 'Here it is.\n```json\n' + json + '\n```\nDone.';

describe('parseNarration', () => {
  it('reads intents from the first fenced json block', () => {
    const out = parseNarration(fence('{"intents":[{"title":"T","summary":"S","steps":["e1","e2"],"considered":["x"],"abandoned":false}]}'), known);
    expect(out).toEqual([
      { title: 'T', summary: 'S', steps: ['e1', 'e2'], considered: ['x'], abandoned: false },
      { title: '', summary: '', steps: ['e3'], considered: [], abandoned: false },
    ]);
  });

  it('drops unknown step ids and fills in unnamed steps as their own intents, in order', () => {
    const out = parseNarration(fence('{"intents":[{"title":"T","summary":"S","steps":["e2","nope"]}]}'), known);
    expect(out?.map((i) => i.steps)).toEqual([['e1'], ['e2'], ['e3']]);
    expect(out?.[1].title).toBe('T');
  });

  it('a step named twice belongs to the first intent that names it', () => {
    const out = parseNarration(fence('{"intents":[{"title":"A","summary":"","steps":["e1"]},{"title":"B","summary":"","steps":["e1","e2"]}]}'), known);
    expect(out?.map((i) => i.steps)).toEqual([['e1'], ['e2'], ['e3']]);
  });

  it('returns null with no block, with malformed json, and with a block lacking intents', () => {
    expect(parseNarration('no block here', known)).toBeNull();
    expect(parseNarration(fence('{"intents": ['), known)).toBeNull();
    expect(parseNarration(fence('{"steps": []}'), known)).toBeNull();
    expect(parseNarration(fence('{"intents": "x"}'), known)).toBeNull();
  });

  it('accepts a bare ``` fence and coerces missing fields', () => {
    const out = parseNarration('```\n{"intents":[{"title":1,"steps":["e1"]}]}\n```', known);
    expect(out?.[0]).toEqual({ title: '', summary: '', steps: ['e1'], considered: [], abandoned: false });
  });

  it('skips a non-json fence before the json one and reads an upper-case JSON tag', () => {
    const answer = 'First:\n```ts\nconst x = 1;\n```\nThen:\n```JSON\n{"intents":[{"title":"T","summary":"S","steps":["e1"]}]}\n```';
    expect(parseNarration(answer, known)?.[0]).toEqual({ title: 'T', summary: 'S', steps: ['e1'], considered: [], abandoned: false });
  });
});

describe('narrationFields', () => {
  const intent = (title: string, steps: string[]) => ({ title, summary: '', steps, considered: [], abandoned: false });

  it('is nothing without a row', () => {
    expect(narrationFields(null, known)).toEqual({ narration: null, narrationFailed: false, narrationPending: false, narrationFailure: null });
  });

  it('lays stored intents over the current steps: a step added since is its own intent and counts as stale', () => {
    const out = narrationFields({ status: 'done', intents: [intent('A', ['e1', 'e2'])], failure: null }, ['e1', 'e2', 'e3']);
    expect(out.narration).toEqual({ intents: [intent('A', ['e1', 'e2']), intent('', ['e3'])], staleSteps: 1 });
  });

  it('drops a step the transcript no longer has, and the narration when none is left', () => {
    const state = { status: 'done' as const, intents: [intent('A', ['gone', 'e1'])], failure: null };
    expect(narrationFields(state, ['e1']).narration).toEqual({ intents: [intent('A', ['e1'])], staleSteps: 0 });
    expect(narrationFields({ ...state, intents: [intent('A', ['gone'])] }, ['e1']).narration).toBeNull();
  });

  it('keeps the previous intents while a run is pending, and reports a failure with its reason', () => {
    const pending = narrationFields({ status: 'running', intents: [intent('A', ['e1'])], failure: null }, ['e1']);
    expect(pending).toMatchObject({ narrationPending: true, narrationFailed: false, narrationFailure: null });
    expect(pending.narration?.intents[0].title).toBe('A');
    expect(narrationFields({ status: 'failed', intents: null, failure: 'refused' }, ['e1']))
      .toEqual({ narration: null, narrationFailed: true, narrationPending: false, narrationFailure: 'refused' });
  });
});
