import { describe, it, expect } from 'vitest';
import { parseNarration } from '../src/walkthrough/narration.js';

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
