/**
 * The walkthrough's wire format (adr: an-orbital-tag-marks-a-walkthrough-turn).
 *
 * The walkthrough used to send its narrate and ask turns into the session,
 * tagged so they could be found again. It sends nothing now — narration is a
 * separate query (spec 2026-09-30-narrate-out-of-band-design) and asking is
 * gone — but transcripts written before still hold such turns, and the tag is
 * what folds them behind a chip in the transcript and keeps their answers out
 * of the walkthrough's story. The parser treats the tag as one of its noise
 * blocks (`NOISE_BLOCK` in `transcript/parser.ts`).
 */

export const WALKTHROUGH_TAG = 'orbital-walkthrough';

export type WalkthroughTag =
  | { kind: 'narrate' }
  | { kind: 'ask'; step: string; n: number | null };

const OPEN_TAG = new RegExp(`<${WALKTHROUGH_TAG}\\b([^>]*)>`);

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? m[1] : null;
}

export function parseWalkthroughTag(text: string): WalkthroughTag | null {
  const m = OPEN_TAG.exec(text);
  if (!m) return null;
  const attrs = m[1];
  const kind = attr(attrs, 'kind');
  if (kind === 'narrate') return { kind: 'narrate' };
  if (kind === 'ask') {
    const step = attr(attrs, 'step');
    if (!step) return null;
    const rawN = attr(attrs, 'n');
    const n = rawN !== null && /^\d+$/.test(rawN) ? Number(rawN) : null;
    return { kind: 'ask', step, n };
  }
  return null;
}

/** The chip label the transcript shows for a folded walkthrough turn (canvas 21g). */
export function walkthroughChipName(tag: WalkthroughTag): string {
  if (tag.kind === 'narrate') return 'walkthrough · narrate';
  return tag.n === null ? 'walkthrough · ask' : `walkthrough · ask · step ${tag.n}`;
}
