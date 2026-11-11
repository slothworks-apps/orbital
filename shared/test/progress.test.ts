import { describe, expect, it } from 'vitest';
import { applyProgressCall, progressFigure, readProgressCall, type ProgressItem } from '../src/progress.js';

const list: ProgressItem[] = [
  { title: 'Read the spec', state: 'done' },
  { title: 'Write the parser', state: 'in_progress' },
  { title: 'Wire the route', state: 'pending' },
];

describe('readProgressCall', () => {
  it('reads a well-formed call as it is', () => {
    expect(readProgressCall({ items: list, reason: 'Found a second caller.', new_list: true })).toEqual({
      items: list, reason: 'Found a second caller.', new_list: true,
    });
  });

  it('is null for what is not a call at all', () => {
    for (const input of [null, undefined, 'items', 3, [], {}, { items: 'a' }, { items: null }]) {
      expect(readProgressCall(input), JSON.stringify(input)).toBeNull();
    }
  });

  it('leaves out untitled and repeated items, and reads an unknown state as pending', () => {
    expect(readProgressCall({
      items: [
        null, 'a', { state: 'done' }, { title: '  ', state: 'done' }, { title: 7 },
        { title: 'A', state: 'finished', reason: '' },
        { title: 'B', state: 'dropped', reason: 'Not needed.' },
        { title: 'A', state: 'done' },
      ],
      reason: '   ',
      new_list: 'yes',
    })).toEqual({
      items: [{ title: 'A', state: 'pending' }, { title: 'B', state: 'dropped', reason: 'Not needed.' }],
    });
  });
});

describe('applyProgressCall', () => {
  it('writes the first list, and a new list over an old one', () => {
    expect(applyProgressCall(null, { items: list })).toEqual({ items: list, change: { kind: 'written', items: list } });
    expect(applyProgressCall(null, { items: list, new_list: true }).change.kind).toBe('written');
    const next = [{ title: 'Ship it', state: 'pending' as const }];
    expect(applyProgressCall(list, { items: next, new_list: true, reason: 'A new task.' })).toEqual({
      items: next, change: { kind: 'new_list', items: next, previous: list, reason: 'A new task.' },
    });
  });

  it('calls a change of states alone a tick', () => {
    const items = list.map((item) => ({ ...item, state: 'done' as const }));
    expect(applyProgressCall(list, { items })).toEqual({ items, change: { kind: 'ticked' } });
  });

  it('names what was added and dropped, with the reasons', () => {
    const result = applyProgressCall(list, {
      items: [
        list[0],
        { title: 'Write the parser', state: 'dropped', reason: 'The CLI already has one.' },
        { title: 'Add a test', state: 'pending' },
        list[2],
      ],
      reason: 'Found an existing parser.',
    });
    expect(result.change).toEqual({
      kind: 'changed',
      added: ['Add a test'],
      dropped: [{ title: 'Write the parser', reason: 'The CLI already has one.' }],
      reason: 'Found an existing parser.',
    });
    expect(progressFigure(result.items)).toEqual({ done: 1, total: 3 });
  });

  it('keeps an item left out where it was, dropped', () => {
    const result = applyProgressCall(list, { items: [list[0], list[2], { title: 'New', state: 'pending' }] });
    expect(result.items.map((item) => [item.title, item.state])).toEqual([
      ['Read the spec', 'done'], ['Write the parser', 'dropped'], ['Wire the route', 'pending'], ['New', 'pending'],
    ]);
    expect(result.change).toEqual({ kind: 'changed', added: ['New'], dropped: [{ title: 'Write the parser' }] });
  });

  it('keeps left-out items first when nothing before them stays, in their order', () => {
    const result = applyProgressCall(list, { items: [list[2]] });
    expect(result.items.map((item) => item.title)).toEqual(['Read the spec', 'Write the parser', 'Wire the route']);
    expect(result.items.slice(0, 2).every((item) => item.state === 'dropped')).toBe(true);
  });

  it('keeps an item dropped before with its reason, sent again or left out, and does not drop it twice', () => {
    const dropped: ProgressItem[] = [list[0], { title: 'Write the parser', state: 'dropped', reason: 'Not needed.' }, list[2]];
    const resent = applyProgressCall(dropped, { items: [list[0], { title: 'Write the parser', state: 'dropped' }, list[2]] });
    expect(resent.items[1]).toEqual({ title: 'Write the parser', state: 'dropped', reason: 'Not needed.' });
    expect(resent.change).toEqual({ kind: 'ticked' });
    const left = applyProgressCall(dropped, { items: [list[0], list[2]] });
    expect(left.items[1]).toEqual({ title: 'Write the parser', state: 'dropped', reason: 'Not needed.' });
    expect(left.change).toEqual({ kind: 'ticked' });
  });

  it('counts an item taken back from dropped as added', () => {
    const dropped: ProgressItem[] = [{ title: 'A', state: 'dropped', reason: 'Later.' }];
    expect(applyProgressCall(dropped, { items: [{ title: 'A', state: 'pending' }], reason: 'Needed after all.' }).change)
      .toEqual({ kind: 'changed', added: ['A'], dropped: [], reason: 'Needed after all.' });
  });
});

describe('progressFigure', () => {
  it('counts done of the items that are not dropped', () => {
    expect(progressFigure([])).toEqual({ done: 0, total: 0 });
    expect(progressFigure([
      { title: 'a', state: 'done' }, { title: 'b', state: 'dropped' }, { title: 'c', state: 'in_progress' },
    ])).toEqual({ done: 1, total: 2 });
  });
});
