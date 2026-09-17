import { readFileSync } from 'node:fs';
import { parseTranscript } from '../transcript/parser.js';
import type { SubagentStore } from '../transcript/subagents.js';
import { TranscriptTail } from './tail.js';
import type { SessionRegistry } from './registry.js';

export interface LiveSubagentWatcherOpts {
  registry: SessionRegistry;
  store: SubagentStore;
  /** Where a live session's transcript lives, or null while it can't be resolved yet. */
  transcriptPath(sessionId: string): string | null;
  /** Called whenever a session's running-subagent set changed. */
  onChange(sessionId: string): void;
  enabled?: boolean;
}

/**
 * Keeps `SubagentStore` current for *every* live terminal session, not just
 * the one the browser has open.
 *
 * Without this, subagent state only existed for the selected session (the
 * on-demand tail in index.ts), while the map draws moons around every planet
 * — so a subagent in any unselected session was invisible by construction.
 *
 * Each watched session gets a two-phase read:
 *
 *  1. **Catch-up** — the transcript so far is parsed once, straight into the
 *     store. A subagent that started before orbital looked is the whole point;
 *     a tail starting at EOF can never see its `Task` block and would then
 *     drop its `tool_result` as unmatched.
 *  2. **Tail from there** — appends only, same as the on-demand tail.
 *
 * Deliberately publishes no `message` events: the on-demand tail owns those,
 * and a second publisher on `session:<id>` would double every message of a
 * session that is both live and selected. Both feed the same store, which
 * absorbs the duplicate entries without emitting a spurious change.
 */
export class LiveSubagentWatcher {
  private tails = new Map<string, TranscriptTail>();
  private enabled: boolean;

  constructor(private opts: LiveSubagentWatcherOpts) {
    this.enabled = opts.enabled ?? true;
  }

  start(): void {
    this.opts.registry.on('upsert', this.onUpsert);
    this.opts.registry.on('remove', this.onRemove);
    this.sync();
  }

  /**
   * Reconcile the watched set with the registry. Also the retry hook for a
   * session whose transcript wasn't resolvable yet (not indexed, or the file
   * not written): the indexer calls this after every re-index.
   */
  sync(): void {
    if (!this.enabled) return;
    for (const live of this.opts.registry.all()) this.watch(live.sessionId);
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) return this.sync();
    // Switched off: stop reading, and forget what was read. Leaving the last
    // known agents in the store would pin stale moons to the map forever,
    // since nothing is left to observe their `tool_result`.
    for (const sessionId of [...this.tails.keys()]) this.unwatch(sessionId);
  }

  stop(): void {
    this.opts.registry.off('upsert', this.onUpsert);
    this.opts.registry.off('remove', this.onRemove);
    for (const tail of this.tails.values()) tail.stop();
    this.tails.clear();
  }

  private onUpsert = (live: { sessionId: string }): void => {
    if (this.enabled) this.watch(live.sessionId);
  };

  private onRemove = (sessionId: string): void => {
    this.unwatch(sessionId);
  };

  private watch(sessionId: string): void {
    if (this.tails.has(sessionId)) return;
    const path = this.opts.transcriptPath(sessionId);
    if (!path) return;

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return; // not written yet — retried on the next upsert or sync()
    }
    // Hand the tail the offset of the last complete line rather than the file
    // size: a transcript caught mid-write ends in a partial line, which
    // parseTranscript drops. Starting the tail past it would lose that entry.
    const lastNewline = text.lastIndexOf('\n');
    const consumed = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
    this.feed(sessionId, consumed);

    const tail = new TranscriptTail(path);
    tail.on('entries', (entries) => {
      if (this.opts.store.feed(sessionId, entries)) this.opts.onChange(sessionId);
    });
    tail.start(Buffer.byteLength(consumed));
    this.tails.set(sessionId, tail);
  }

  private unwatch(sessionId: string): void {
    const tail = this.tails.get(sessionId);
    if (tail) {
      tail.stop();
      this.tails.delete(sessionId);
    }
    const hadAgents = this.opts.store.get(sessionId).length > 0;
    this.opts.store.drop(sessionId);
    if (hadAgents) this.opts.onChange(sessionId);
  }

  private feed(sessionId: string, text: string): void {
    if (!text) return;
    if (this.opts.store.feed(sessionId, parseTranscript(text))) this.opts.onChange(sessionId);
  }
}
