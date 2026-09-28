import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { api } from '../lib/api'
import { chordLabel, command, matches } from '../lib/keymap'
import {
  commandNameSet,
  completionContext,
  tokenizeComposer,
  unknownCommand,
} from '../lib/composerTokens'
import { CompletionPopup, type CompletionHandle } from './CompletionPopup'
import { AttachmentChip } from './AttachmentChip'
import { ATTACHMENT_TYPES_LINE, MAX_ATTACHMENTS, filesFrom } from '../lib/attachments'
import type { AttachmentsHandle } from './useAttachments'
import { IdeSlot, IDE_SLOT_HEIGHT_PX } from './IdeSlot'
import { lineCountLabel, selectionId } from '../lib/ideSelection'
import { useIdeReadout } from '../lib/useIdeReadout'
import type { CompletionKey, IdeContext, SlashCommand } from '../lib/types'

/**
 * The prompt composer — one control, two homes (spec:
 * 2026-09-20-composer-design § The component; canvas 9a/9b/9d). Mounted in
 * `DetailPanel`'s footer and as the New Session dialog's FIRST PROMPT field.
 *
 * ## How the highlight stays in lockstep
 *
 * The field's own text is transparent (the caret keeps the accent colour) and
 * an `aria-hidden` mirror behind it renders the same string with token spans.
 * Three things keep the two in register, and all three are load-bearing:
 *
 * 1. `FIELD_METRICS` is applied to BOTH elements — one string, so font,
 *    size, leading and wrapping cannot drift apart. Neither element carries
 *    padding of its own (the well owns it, canvas 9a), so there is no padding
 *    to keep in sync either.
 * 2. Token spans cancel their own padding with an equal negative margin, so a
 *    token contributes exactly the width of its glyphs. The canvas pairs `1px
 *    5px` with `0 -2px`, which does not cancel — that compensated for the
 *    canvas setting tokens in mono at 12.5 inside 13.5 sans prose. The spec
 *    drops the font change (a mirror cannot survive one), so the compensation
 *    goes with it; keeping it would slide every glyph after a token 6px off
 *    the caret. See "Deviations" in the spec, same constraint.
 * 3. The mirror scrolls with the field, and the field never wraps differently:
 *    `text-wrap: pretty` is deliberately absent, since a textarea does not
 *    honour it and the mirror would break its lines somewhere else.
 *
 * ## Image intake
 *
 * Split in two on purpose (spec § Image intake). `useAttachments` owns the
 * chips — the state machine, the uploads, the refusal line — because the panel's
 * Send button and the send path read it too. `useImageDrop` owns the drag,
 * because the drop TARGET is an ancestor this component does not own: the whole
 * panel in one mount, the dialog surface in the other. All this component does
 * with either is draw them: the chip row above the text, the marker over the
 * well, the refusal line in place of the hint. Paste is the one intake that is
 * genuinely the field's, so it hangs off the textarea here.
 */

/**
 * Everything that decides where a glyph lands. Applied verbatim to the field
 * and to the mirror; nothing else may set any of these on either element.
 * Canvas 9a/9e: prose 13.5px at 1.62.
 */
export const FIELD_METRICS = 'font-sans text-[13.5px] leading-[1.62] whitespace-pre-wrap break-words'

/**
 * The field stops growing here and starts scrolling — eight lines at 13.5/1.62.
 * The canvas gives a min-height (96px, dialog) but no ceiling; without one the
 * panel footer would eat the transcript.
 */
const MAX_FIELD_PX = 176

/** Debounce before a hand-typed path is checked against the filesystem. */
const MENTION_PROBE_MS = 250

/**
 * What the hint line says while the completion list is up (canvas 9b's well).
 * The same in both mounts: with the list open, ⏎ is the list's in either one,
 * so the mount's own resting copy would be describing a key it does not have.
 */
const POPUP_HINT = '⏎ accept · esc closes the list · ⌘V paste image'

export interface ComposerProps {
  /** Which session (panel) or directory (dialog) completions resolve against. */
  sessionKey: CompletionKey
  value: string
  onChange: (value: string) => void
  /** ⏎ sends in the panel, newlines in the dialog (canvas 9d). */
  enter: 'send' | 'newline'
  /** Called with the trimmed text when ⏎ sends. */
  onSend?: (text: string) => void
  /** The popup opens above on the panel floor, below in the dialog (canvas 9b/9d). */
  placement: 'above' | 'below'
  /** Well geometry: 12/12/10 in the panel, 12/14/10 over a 96px floor in the dialog (9e). */
  variant: 'panel' | 'dialog'
  /** Resting hint copy. The popup and the unknown-command note swap in over it. */
  hint: string
  /**
   * A question is open and ⏎ answers it rather than starting a new turn
   * (spec: 2026-09-20-interactive-decisions-design; canvas 9c). Border steps
   * to the accent, and the hint line takes the accent plus the blinking dot.
   * The copy itself still comes from `hint` — this only says how it is worn.
   */
  answering?: boolean
  placeholder?: string
  id?: string
  'aria-label'?: string
  /** Rendered at the right end of the hint row — the panel's Stop/Send buttons. */
  actions?: ReactNode
  /**
   * The editor covering this mount's directory, or null/absent when there is
   * none (spec 2026-09-23-ide-bridge-design § The slot and the lip). The
   * composer draws the slot on the well's top edge, names what ⏎ will carry in
   * the hint line, and lifts the completion popup clear of both (canvas
   * `Feature - IDE bridge` 20c).
   *
   * The readout's two rates live here rather than in `IdeSlot` because the hint
   * line needs the same answer, and running the hook twice would run two
   * independent debounces over one stream.
   */
  ide?: IdeContext | null
  /** The selection id THIS session has dropped with the lip's ×, if any. */
  ideDismissedId?: string
  /** Called with the dropped selection's id. Per session (spec § Behaviour). */
  onIdeDismiss?: (selectionId: string) => void
  /**
   * The mount's attachment state (`useAttachments`). Absent means this mount
   * has nowhere to upload to, and then there is no chip row, no paste intake
   * and no refusal line — see the note in `NewSessionDialog`.
   */
  attachments?: AttachmentsHandle
  /**
   * The drop state, armed by the mount's own `useImageDrop` over its own
   * surface. The well becomes the marker while it is true (canvas 9c-1).
   */
  dropArmed?: boolean
  /** Layout-only passthrough. */
  className?: string
}

export function Composer({
  sessionKey,
  value,
  onChange,
  enter,
  onSend,
  placement,
  variant,
  hint,
  answering = false,
  placeholder,
  id,
  actions,
  ide = null,
  ideDismissedId,
  onIdeDismiss,
  attachments,
  dropArmed = false,
  className,
  ...aria
}: ComposerProps) {
  const listboxId = `${useId()}-completions`
  const wellRef = useRef<HTMLDivElement | null>(null)
  const mirrorRef = useRef<HTMLDivElement | null>(null)
  const fieldRef = useRef<HTMLTextAreaElement | null>(null)
  const popupRef = useRef<CompletionHandle | null>(null)
  /** Caret to restore after a controlled value change lands. */
  const pendingCaret = useRef<number | null>(null)

  const [focused, setFocused] = useState(false)
  const [caret, setCaret] = useState(value.length)
  const [activeDescendant, setActiveDescendant] = useState<string | null>(null)
  /** Escape closes the list without touching the text; it stays closed until
   * the token is left and re-entered. */
  const [dismissed, setDismissed] = useState(false)
  const [commands, setCommands] = useState<readonly SlashCommand[] | null>(null)
  /** Mentions whose path the server has confirmed — the tint is that receipt. */
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set())
  /** Paths already probed, so a path that does not exist is asked about once. */
  const probed = useRef<Set<string>>(new Set())

  const keyId = 'session' in sessionKey ? `s:${sessionKey.session}` : `c:${sessionKey.cwd}`

  // A different session or directory is a different catalog and a different
  // filesystem; nothing learned about the last one carries over.
  useEffect(() => {
    setCommands(null)
    setResolved(new Set())
    probed.current = new Set()
  }, [keyId])

  /**
   * The list reports its active row, and it only has one while it is actually
   * painted — which makes this the popup's "on screen" flag as well as the
   * field's `aria-activedescendant`.
   */
  const popupShown = activeDescendant !== null

  const context = useMemo(() => completionContext(value, caret), [value, caret])
  const popupOpen = context !== null && !dismissed
  useEffect(() => {
    if (context === null && dismissed) setDismissed(false)
  }, [context, dismissed])

  /**
   * The catalog is fetched as soon as anything could need it: the popup opening
   * on `/`, or a field that merely STARTS with a slash — a pasted
   * `/code-review the diff` never opens a popup and must still be tinted (and
   * must not draw a "no command" note just because nothing had been fetched).
   */
  const wantsCommands = value.startsWith('/') || context?.kind === 'command'
  useEffect(() => {
    if (!wantsCommands || commands !== null) return
    let cancelled = false
    api
      .commands(sessionKey)
      .then((next) => {
        if (!cancelled) setCommands(next)
      })
      .catch(() => {
        // No catalog is "no commands": prose is still sendable, and a note
        // about a command we cannot list would be a guess.
        if (!cancelled) setCommands([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsCommands, commands, keyId])

  const knownCommands = useMemo(() => commandNameSet(commands ?? []), [commands])
  const tokens = useMemo(() => tokenizeComposer(value, knownCommands), [value, knownCommands])
  const note = useMemo(() => {
    if (commands === null) return null
    const slug = unknownCommand(value, knownCommands)
    return slug === null ? null : `no command ${slug} — sends as typed`
  }, [commands, value, knownCommands])

  /** Mention runs with their offsets — the offsets tell the probe which one the caret is in. */
  const mentions = useMemo(() => {
    const out: Array<{ path: string; start: number }> = []
    let offset = 0
    for (const token of tokens) {
      if (token.kind === 'mention') out.push({ path: token.path, start: offset })
      offset += token.text.length
    }
    return out
  }, [tokens])

  /**
   * One unconfirmed mention at a time, debounced: `files/complete` on the whole
   * path answers with the directory's entries, and an entry whose name is the
   * path's own basename means the path exists. Each resolution re-renders and
   * the next unconfirmed mention takes its turn. The token being typed right
   * now is skipped — the popup is already asking about that one.
   */
  useEffect(() => {
    const pending = mentions.find(
      (m) =>
        !resolved.has(m.path) &&
        !probed.current.has(m.path) &&
        !(context !== null && context.start === m.start),
    )
    if (!pending) return
    const timer = setTimeout(() => {
      probed.current.add(pending.path)
      api
        .filesComplete(sessionKey, pending.path)
        .then((entries) => {
          const dir = pending.path.slice(0, pending.path.lastIndexOf('/') + 1)
          // The row's own path, not its base name: with an editor connected
          // the list also carries open tabs matched by base name from
          // elsewhere in the tree (spec 2026-09-23-ide-bridge-design § Open
          // files), and one of those must not confirm a path that is not
          // there. `path` is sent only when it cannot be derived.
          // A path ending in `/` has no basename to match; a directory that
          // lists anything at all exists.
          const exists =
            dir === pending.path
              ? entries.length > 0
              : entries.some((e) => (e.path ?? dir + e.name) === pending.path)
          if (exists) setResolved((prev) => new Set(prev).add(pending.path))
        })
        .catch(() => {
          // Unconfirmed stays untinted. Nothing to report.
        })
    }, MENTION_PROBE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentions, resolved, context, keyId])

  // Restore the caret after an accept, once the controlled value has landed.
  useLayoutEffect(() => {
    const pos = pendingCaret.current
    if (pos === null) return
    pendingCaret.current = null
    fieldRef.current?.setSelectionRange(pos, pos)
  })

  const syncCaret = useCallback(() => {
    setCaret(fieldRef.current?.selectionStart ?? 0)
  }, [])

  const handleAccept = useCallback(
    (insert: string, keepOpen: boolean) => {
      if (context === null) return
      const el = fieldRef.current
      const end = el?.selectionStart ?? caret
      // One trailing space on accept; a directory gets none, because the popup
      // stays open and keeps completing inside it (canvas 9b).
      const tail = keepOpen ? '' : ' '
      const next = value.slice(0, context.start) + insert + tail + value.slice(end)
      const nextCaret = context.start + insert.length + tail.length
      // Accepting a path IS the confirmation — no probe needed (spec:
      // "applied on popup accept").
      if (insert.startsWith('@')) setResolved((prev) => new Set(prev).add(insert.slice(1)))
      pendingCaret.current = nextCaret
      setCaret(nextCaret)
      onChange(next)
    },
    [context, caret, value, onChange],
  )

  /** The mount's chip row. Memoised on the handle rather than rebuilt every
   * render, because the hint line's `useMemo` below depends on it. */
  const chips = useMemo(() => attachments?.items ?? [], [attachments?.items])
  const anyFailed = chips.some((chip) => chip.state === 'failed')
  const refusal = attachments?.refusal ?? null

  // The editor slot's two rates, run once for the slot and the hint line both
  // (spec 2026-09-23-ide-bridge-design § The slot and the lip).
  const ideReadout = useIdeReadout(ide?.selection ?? null)
  const ideLip = ideReadout.lip
  const ideStanding = ideLip !== null && selectionId(ideLip) !== ideDismissedId
  /**
   * What ⏎ will carry, said in the hint line (canvas `Feature - IDE bridge`
   * 20b-3/20b-6): `⏎ send with 5 lines · ⇧⏎ newline`, and the images alongside
   * when there are any. It replaces the mount's RESTING copy only — an open
   * question's hint is about the question and outranks it.
   */
  const ideHint = useMemo(() => {
    if (!ideStanding || !ideLip) return null
    const armed = chips.filter((chip) => chip.state !== 'failed').length
    const images = armed > 0 ? `, ${armed} image${armed === 1 ? '' : 's'}` : ''
    const carries = `${lineCountLabel(ideLip)}${images}`
    // In the dialog the bare key is a newline, so `composer.send`'s chord
    // names it in both mounts.
    const bare = chordLabel(command('composer.send').chords[0])
    return enter === 'send'
      ? `${bare} send with ${carries} · ${chordLabel(command('composer.newline').chords[0])} newline`
      : `${bare} newline · ${chordLabel(command('composer.start').chords[0])} start session with ${carries}`
  }, [ideStanding, ideLip, chips, enter])

  function handleKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    // The list gets first refusal on every key — it owns ↑↓, ⏎ and Tab while
    // it is on screen, and nothing else (spec § Completion popup).
    if (popupRef.current?.handleKeyDown(e)) return
    // `matches` wants the exact modifier set, so `composer.newline` (the
    // browser's own newline) and ⌘⏎ — which belongs to whoever is listening
    // further out, the dialog's `composer.start` — are never a send.
    if (enter === 'send' && matches(command('composer.send').chords[0], e)) {
      e.preventDefault()
      const text = value.trim()
      // An armed chip is a sendable turn on its own — an image with no words is
      // a whole message (spec § Send). Empty and unarmed still sends nothing.
      if (text || attachments?.armed) onSend?.(text)
    }
  }

  return (
    <div className={className}>
      <div
        ref={wellRef}
        data-composer-well
        data-focused={focused || undefined}
        // Canvas 9a/9e: 10px radius over rgba(4,8,16,.6) inside a .18
        // hairline; focus takes the accent at .5 plus a 3px accent .1 glow.
        // `--color-accent` is oklch(85% .12 205) precomputed (theme.css), which
        // is this feature's accent throughout. The column gap is the 10px both
        // wells carry (9c-2 and 9d-D) — chip row to text, text to hint line.
        className={[
          'relative flex flex-col gap-2.5 rounded-[10px] border bg-[rgba(4,8,16,.6)]',
          variant === 'dialog' ? 'min-h-24 px-3.5 pb-2.5 pt-3' : 'px-3 pb-2.5 pt-3',
          // 9c-1: the marker is 96px tall, so the panel's well grows to it for
          // the duration of the drag — the dialog's already is.
          dropArmed ? 'min-h-24' : '',
          // Canvas 9c COLOUR: "composer pending border — accent/.38 → .5
          // typed". The typed state is the same chrome focus already wears,
          // which is why they share a branch.
          focused || (answering && value.length > 0)
            ? 'border-accent/50 ring-[3px] ring-accent/10'
            : answering
              ? 'border-accent/38'
              : 'border-[rgba(150,205,255,.18)]',
        ].join(' ')}
      >
        {/* The editor slot, on the well's top edge (canvas `Feature - IDE
            bridge` 20a, placement C of 20e). It lives inside the well because
            the well is the positioned ancestor; the clip that makes the slide
            read as "from behind the edge" is inside `IdeSlot`, never on the
            well — an `overflow-hidden` here would cut nothing today (the popup
            is portalled) but would be one refactor away from doing so
            (web/CLAUDE.md). */}
        <IdeSlot
          ideName={ide?.ideName ?? null}
          readout={ideReadout}
          standing={ideStanding}
          onDismiss={(selection) => onIdeDismiss?.(selection)}
        />

        {/* The chip row: above the text, inside the well (canvas 9c-2). Three
            fit across a 418px well and it wraps to a second row. */}
        {chips.length > 0 && (
          <div data-composer-chips className="flex flex-wrap gap-2">
            {chips.map((chip) => (
              <AttachmentChip
                key={chip.id}
                chip={chip}
                onRemove={attachments!.remove}
                onRetry={attachments!.retry}
              />
            ))}
          </div>
        )}

        {/* 9d-B's note line, under the chip it belongs to. One line for the row,
            not one per chip: it says the same thing about every failure, and the
            canvas shows exactly one. */}
        {anyFailed && (
          <div
            data-testid="attachment-note"
            className="flex items-center gap-2 font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.5)]"
          >
            <span
              aria-hidden
              className="block h-[11px] w-[11px] shrink-0 rounded-[3px] border border-[rgba(160,190,225,.35)]"
            />
            The upload didn&apos;t finish. Nothing else was lost.
          </div>
        )}

        <div className="relative">
          <div
            ref={mirrorRef}
            aria-hidden="true"
            data-composer-mirror
            className={`pointer-events-none absolute inset-0 overflow-hidden text-text-bright ${FIELD_METRICS}`}
          >
            {tokens.map((token, index) => {
              if (token.kind === 'command') {
                return (
                  <span
                    key={index}
                    data-token="command"
                    // 9a/9e: filled slug, rgba(150,205,255,.13) under #f2f9ff
                    // ink, 4px radius, padding cancelled by the margin (see the
                    // lockstep note above). No transition — 9e: "meant to read
                    // as the field having always known".
                    className="-mx-[5px] box-decoration-clone rounded-[4px] bg-[rgba(150,205,255,.13)] px-[5px] py-px text-[#f2f9ff] transition-none"
                  >
                    {token.text}
                  </span>
                )
              }
              if (token.kind === 'mention') {
                // The tint is the receipt for a RESOLVED name; an unconfirmed
                // path stays plain ink (9b: "not tinted while you are still
                // typing it").
                if (!resolved.has(token.path)) return token.text
                return (
                  <span
                    key={index}
                    data-token="mention"
                    // 9a/9e: .06 fill + a 1px .18 inset ring under #dfeeff ink.
                    className="-mx-[5px] box-decoration-clone rounded-[4px] bg-[rgba(150,205,255,.06)] px-[5px] py-px text-[#dfeeff] shadow-[inset_0_0_0_1px_rgba(150,205,255,.18)] transition-none"
                  >
                    @{token.path}
                    {token.suffix && (
                      <span data-token-suffix className="text-[rgba(160,190,225,.6)]">
                        {token.suffix}
                      </span>
                    )}
                  </span>
                )
              }
              return token.text
            })}
            {/* A trailing newline has no glyph, so the mirror would be one line
                shorter than the field. A zero-width space gives it one. */}
            {value.endsWith('\n') && '​'}
          </div>

          <textarea
            ref={fieldRef}
            id={id}
            aria-label={aria['aria-label']}
            aria-controls={activeDescendant ? listboxId : undefined}
            aria-activedescendant={activeDescendant ?? undefined}
            value={value}
            // The last chip that fits hides the placeholder, never the text
            // (canvas 9c-2): a full chip row plus a placeholder is two things
            // competing for the same line.
            placeholder={chips.length >= MAX_ATTACHMENTS ? undefined : placeholder}
            onChange={(e) => {
              setCaret(e.target.selectionStart ?? e.target.value.length)
              onChange(e.target.value)
            }}
            // Paste is the field's own intake (⌘V, canvas 9c). The event is NOT
            // prevented: a clipboard carrying both an image and text should
            // still paste the text.
            onPaste={
              attachments &&
              ((e) => {
                const files = filesFrom(e.clipboardData)
                if (files.length > 0) attachments.accept(files, 'clipboard')
              })
            }
            onKeyDown={handleKeyDown}
            onSelect={syncCaret}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            // Transparent ink over the mirror, accent caret (9e). The
            // placeholder sets its own colour, so it survives the transparency.
            className={`relative block min-h-[36px] w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-transparent caret-accent [field-sizing:content] placeholder:text-[rgba(160,190,225,.5)] focus:outline-none ${FIELD_METRICS}`}
            // Grows with the text, then scrolls. field-sizing rather than a
            // measured scrollHeight: scrollHeight is a whole pixel and the
            // lines are not, so a measured field came out a fraction short,
            // scrolled by that fraction and slid the caret off the mirror.
            style={{ maxHeight: MAX_FIELD_PX }}
            // Past MAX_FIELD_PX the field scrolls, and the mirror has to scroll
            // with it — the third leg of the lockstep.
            onScroll={(e) => {
              const m = mirrorRef.current
              if (m) m.scrollTop = e.currentTarget.scrollTop
            }}
          />
        </div>

        {/* Hint row — 8px above, mono 10 at .06em (9e). Four states, in this
            order: the open list's own keys (9b), the refusal line (9d-C), the
            unknown-command note in the NOT IN CACHE voice (9a), then the
            mount's resting copy. The refusal REPLACES the hint in place, which
            is why it is a branch here and not a line of its own — nothing
            reflows when it arrives or leaves. */}
        <div className="flex items-center gap-2">
          {popupShown ? (
            <span className="font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.5)]">
              {POPUP_HINT}
            </span>
          ) : refusal ? (
            <span
              data-testid="composer-refusal"
              // In .16s, out .2s (9e). 9d-C's voice: an 11px glyph, the label
              // tracked out, the measured fact in brighter ink, one sentence.
              className={[
                'flex items-center gap-2 font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.55)]',
                refusal.exiting ? 'orbital-refusal-out' : 'orbital-refusal-in',
              ].join(' ')}
            >
              <span
                aria-hidden
                className="block h-[11px] w-[11px] shrink-0 rounded-[3px] border border-[rgba(160,190,225,.35)]"
              />
              <span className="tracking-[0.14em] text-[rgba(160,190,225,.5)]">{refusal.label}</span>
              <span aria-hidden className="text-[rgba(150,205,255,.28)]">
                ·
              </span>
              <span className="text-[rgba(220,235,255,.8)]">{refusal.fact}</span>
              {refusal.tail}
            </span>
          ) : note ? (
            <span className="flex items-center gap-2 font-mono text-[11px] tracking-[0.06em] text-[rgba(160,190,225,.5)]">
              <span
                aria-hidden
                className="block h-[11px] w-[11px] shrink-0 rounded-[3px] border border-[rgba(160,190,225,.35)]"
              />
              {note}
            </span>
          ) : answering ? (
            // Canvas 9c: the accent hint with the blinking dot in front of
            // it — the one line that says ⏎ no longer starts a new turn.
            <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.06em] text-accent/90">
              <span
                aria-hidden
                className="orbital-pulse block h-[5px] w-[5px] shrink-0 rounded-full bg-accent"
              />
              {hint}
            </span>
          ) : (
            <span className="font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.5)]">
              {ideHint ?? hint}
            </span>
          )}
          <span aria-hidden className="flex-1" />
          {actions}
        </div>

        {/* The marker (canvas 9c-1). An overlay rather than a swap, because the
            typed text is KEPT for the duration of the drag — hidden under the
            marker, not thrown away. `pointer-events-none` so the drag keeps
            reaching the ancestor that is the real drop target. */}
        {dropArmed && (
          <div
            data-testid="drop-marker"
            aria-hidden
            className="orbital-droppulse pointer-events-none absolute inset-0 flex min-h-24 flex-col items-center justify-center gap-2 rounded-[10px] border-2 border-dashed border-accent/50 bg-accent/7"
          >
            <span className="block h-4 w-4 rounded-[4px] border border-[oklch(88%_.1_205_/_.7)]" />
            <span className="font-mono text-[10px] tracking-[0.14em] text-[oklch(90%_.06_205)]">
              DROP TO ATTACH
            </span>
            <span className="font-mono text-[9.5px] tracking-[0.06em] text-[rgba(190,215,240,.6)]">
              {ATTACHMENT_TYPES_LINE}
            </span>
          </div>
        )}
      </div>

      {context && (
        <CompletionPopup
          ref={popupRef}
          open={popupOpen}
          anchorRef={wellRef}
          context={context}
          sessionKey={sessionKey}
          commands={commands}
          placement={placement}
          // The slot belongs to the well, so the popup clears both (canvas
          // `Feature - IDE bridge` 20c). Only above: the slot sits on the top
          // edge, and the dialog's list opens below it.
          anchorInsetPx={ide && placement === 'above' ? IDE_SLOT_HEIGHT_PX : 0}
          listboxId={listboxId}
          onAccept={handleAccept}
          onClose={() => setDismissed(true)}
          onActiveDescendantChange={setActiveDescendant}
        />
      )}
    </div>
  )
}
