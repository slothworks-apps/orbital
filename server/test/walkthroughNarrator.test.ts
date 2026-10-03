import { describe, it, expect } from 'vitest';
import { narrations } from '../src/db/schema.js';
import { Narrator, type NarrateQueryFn } from '../src/walkthrough/narrator.js';
import { openTmpDb } from './tmp.js';

const answer = (json: string) => '```json\n' + json + '\n```';

/** A query whose answer is held until the test releases it. */
function heldQuery() {
  let release!: (text: string) => void;
  const text = new Promise<string>((r) => { release = r; });
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const fn: NarrateQueryFn = (args) => {
    calls.push(args);
    return (async function* () {
      const t = await text;
      yield { type: 'assistant', message: { content: [{ type: 'text', text: t }] } };
      yield { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: t };
    })();
  };
  return { fn, release, calls };
}

function narrator(queryFn: NarrateQueryFn, db = openTmpDb('narr')) {
  return { db, n: new Narrator({ db, queryFn, model: () => '' }) };
}

describe('Narrator storage', () => {
  it('a running row left by a stopped server is failed / error on load', () => {
    const { db, n } = narrator(heldQuery().fn);
    db.insert(narrations).values({ sessionId: 's1', status: 'running', model: 'sonnet', intents: '[]', startedAt: 1 }).run();
    n.load();
    expect(n.state('s1')).toEqual({ status: 'failed', intents: null, failure: 'error' });
  });

  it('keeps the previous intents while a new run is pending, and replaces them when it lands', async () => {
    const first = heldQuery();
    const { db, n } = narrator(first.fn);
    const done = n.start('s1', 'digest', ['e1']);
    first.release(answer('{"intents":[{"title":"First","summary":"","steps":["e1"]}]}'));
    await done;
    expect(n.state('s1')?.intents?.[0].title).toBe('First');

    const second = heldQuery();
    const again = new Narrator({ db, queryFn: second.fn, model: () => 'opus' });
    const pending = again.start('s1', 'digest', ['e1']);
    expect(again.state('s1')).toMatchObject({ status: 'running', intents: [{ title: 'First' }] });
    second.release(answer('{"intents":[{"title":"Second","summary":"","steps":["e1"]}]}'));
    await pending;
    expect(again.state('s1')).toMatchObject({ status: 'done', intents: [{ title: 'Second' }], failure: null });
    // An empty setting asks the default model; a set one asks that.
    expect(first.calls[0].options.model).toBe('sonnet');
    expect(second.calls[0].options).toMatchObject({ model: 'opus', persistSession: false, allowedTools: [], maxTurns: 1 });
  });
});
