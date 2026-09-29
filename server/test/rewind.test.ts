import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript, type TranscriptEntry } from '../src/transcript/parser.js';
import { presentBranch, readTranscriptBranch } from '../src/transcript/rewind.js';
import { rewindRefusal } from '../src/runner/runner.js';

/**
 * What the rewind feature reads off a transcript (spec
 * 2026-09-29-rewind-design § Which messages can be picked, § Pending rewind).
 */

/** The rewind spike's session: A, then CLI rewinds to E and F, a `/compact`, and I off the compaction. */
const cliRewind = parseTranscript(
  readFileSync(join(import.meta.dirname, 'fixtures/transcript-rewind-cli.jsonl'), 'utf8'),
);

const prompt = (uuid: string, parent: string | null, text = uuid): TranscriptEntry => ({
  type: 'user', uuid, parentUuid: parent, message: { role: 'user', content: text },
});
const says = (uuid: string, parent: string, text = uuid): TranscriptEntry => ({
  type: 'assistant', uuid, parentUuid: parent,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const hook = (uuid: string, parent: string): TranscriptEntry => ({
  type: 'system', subtype: 'stop_hook_summary', uuid, parentUuid: parent,
});

/** Three turns, each answered, each closed by a stop hook — the fork points. */
const threeTurns = [
  prompt('u1', null, 'first'), says('a1', 'u1', 'one'), hook('s1', 'a1'),
  prompt('u2', 's1', 'second'), says('a2', 'u2', 'two'), hook('s2', 'a2'),
  prompt('u3', 's2', 'third'), says('a3', 'u3', 'three'),
];

const texts = (messages: { role: string; text?: string }[]) =>
  messages.map((m) => (m.role === 'rewind' ? '—' : m.text));

describe('readTranscriptBranch: which messages can be picked', () => {
  it('offers every prompt with conversation before it, forking at its parent', () => {
    const read = readTranscriptBranch(threeTurns);
    expect([...read.targets.keys()]).toEqual(['u2', 'u3']);
    expect(read.targets.get('u2')).toEqual({ forkUuid: 's1', newest: false, text: 'second' });
    // Only the newest prompt's drop is a single turn the CLI's guard accepts.
    expect(read.targets.get('u3')).toEqual({ forkUuid: 's2', newest: true, text: 'third' });
    expect(read.messages.filter((m) => m.rewindable).map((m) => m.uuid)).toEqual(['u2', 'u3']);
  });

  it('offers nothing before the newest compaction, and nothing off the live branch', () => {
    const read = readTranscriptBranch(cliRewind);
    const said = (uuid: string) => read.messages.find((m) => m.uuid === uuid)?.text;
    const picked = [...read.targets.keys()].map(said);
    // E and F are on the live branch but before the compaction; G was rewound away.
    expect(picked).not.toContain('say E (reply with just the letter)');
    expect(picked).not.toContain('say F (reply with just the letter)');
    expect(picked).not.toContain('say G (reply with just the letter)');
    expect(picked).toContain('say I (reply with just the letter)');
    const i = [...read.targets.entries()].find(([uuid]) => said(uuid)?.startsWith('say I'))![1];
    expect(i.newest).toBe(true);
    // The compaction's own `<local-command-stdout>` turn is not something the human typed.
    expect(read.messages.filter((m) => m.rewindable).every((m) => m.text || m.command?.name)).toBe(true);
  });

  it('gives a bare slash command back as the human typed it', () => {
    const read = readTranscriptBranch([
      ...threeTurns,
      prompt('u4', 'a3', '<command-name>/review</command-name>\n<command-args>src/a.ts</command-args>'),
    ]);
    expect(read.targets.get('u4')?.text).toBe('/review src/a.ts');
  });
});

describe('presentBranch', () => {
  it('draws a divider without a count where the terminal rewound', () => {
    const shown = presentBranch(readTranscriptBranch(cliRewind), { pendingTarget: null, sent: [] }).messages;
    const dividers = shown.filter((m) => m.role === 'rewind');
    // Off A (dropping B, C), off E (dropping "which letters"), off the compaction (dropping G).
    expect(dividers).toHaveLength(3);
    expect(dividers.every((d) => d.rewind?.hiddenCount === null)).toBe(true);
    const users = shown.filter((m) => m.role === 'user' && m.text?.startsWith('say ') || m.role === 'rewind');
    expect(texts(users)).toEqual([
      'say A (reply with just the letter)', '—',
      'say E (reply with just the letter)', '—',
      'say F (reply with just the letter)', '—',
      'say I (reply with just the letter)',
    ]);
  });

  it('carries the count of a rewind Orbital sent', () => {
    // u3 rewound to before itself, and the edited prompt u3b sent in its place.
    const read = readTranscriptBranch([...threeTurns, prompt('u3b', 's2', 'third, again'), says('a3b', 'u3b', 'ok')]);
    const shown = presentBranch(read, {
      pendingTarget: null,
      sent: [{ forkUuid: 's2', targetUuid: 'u3', hiddenCount: 2, at: 1_000 }],
    }).messages;
    expect(texts(shown)).toEqual(['first', 'one', 'second', 'two', '—', 'third, again', 'ok']);
    expect(shown.find((m) => m.role === 'rewind')).toMatchObject({ id: 'rewind:s2:u3', rewind: { hiddenCount: 2 } });
  });

  it('cuts before a pending rewind\'s target', () => {
    const { messages, cutAt } = presentBranch(readTranscriptBranch(threeTurns), { pendingTarget: 'u2', sent: [] });
    expect(texts(messages)).toEqual(['first', 'one']);
    expect(cutAt).toBeNull(); // the fixture carries no timestamps
  });

  it('keeps cutting a sent rewind until its new prompt reaches the file, the divider at the cut', () => {
    const { messages } = presentBranch(readTranscriptBranch(threeTurns), {
      pendingTarget: null,
      sent: [{ forkUuid: 's2', targetUuid: 'u3', hiddenCount: 2, at: 1_000 }],
    });
    expect(texts(messages)).toEqual(['first', 'one', 'second', 'two', '—']);
    // The same id the fork's divider has once the prompt lands, so the row keeps its place.
    expect(messages.at(-1)).toMatchObject({ id: 'rewind:s2:u3', rewind: { hiddenCount: 2 } });
  });
});

describe('rewindRefusal', () => {
  it('knows both ways the CLI refuses a truncating resume', () => {
    expect(rewindRefusal('Resume rejected by --resume-drops-turn: a user entry not attributable to the declared turn'))
      .toMatch(/^Resume rejected/);
    expect(rewindRefusal('Error: No message found with message.uuid of: abc')).toBe('No message found with message.uuid of: abc');
    expect(rewindRefusal('Claude Code process exited with code 1')).toBeNull();
    expect(rewindRefusal(undefined)).toBeNull();
  });
});
