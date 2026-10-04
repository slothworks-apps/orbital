import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { Extension, type Editor } from '@tiptap/core'
import { Placeholder } from '@tiptap/extensions'
import { Selection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { api } from '../lib/api'
import { chordLabel, command, matches } from '../lib/keymap'
import {
  commandNameSet,
  completionContext,
  tokenizeComposer,
  unknownCommand,
  type CompletionContext,
} from '../lib/composerTokens'
import {
  clipboardMarkdown,
  composerMarkdown,
  composerSchemaExtensions,
  markdownPasteSlice,
  parseComposerMarkdown,
} from '../lib/composerMarkdown'
import {
  composerDecorationsPlugin,
  refreshDecorations,
  type TokenSource,
} from '../lib/composerDecorations'
import { CompletionPopup, sourceLabel, type CompletionHandle } from './CompletionPopup'
import { SkillViewer } from './SkillViewer'
import { FloatingTooltip } from '../ui/Tooltip'
import { PIN_TOOLTIP_DELAY_MS } from './UtilityStrip'
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
 * ## A rich-text field that speaks markdown
 *
 * The field is a Tiptap editor (spec: 2026-09-29-composer-rich-editor-design;
 * ADR the-composer-becomes-a-tiptap-editor): `- ` becomes a bullet, `**word**`
 * comes out bold. What goes in and out is still a markdown string — `value`
 * and `onChange` — so the callers' drafts and the send path never see the
 * editor. `lib/composerMarkdown` owns the schema and both directions of the
 * markdown; `lib/composerDecorations` paints the tokens.
 *
 * The editor is the source of truth while it is being typed in. `value` is
 * parsed back into it only when it differs from the last markdown this field
 * emitted — a session switch, a draft cleared after send — never on its own
 * keystrokes, which would reset the caret.
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
 * genuinely the field's, so it hangs off the editor's DOM here.
 */

/**
 * Body text metrics — canvas 9a/9e: prose 13.5px at 1.62. Formatting that
 * changes size (a heading, a code block) sets its own on top.
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

/** How long the pointer rests on a tinted command before its card shows —
 * the same wait as the pin tooltips, so a pointer crossing the field on its
 * way somewhere else raises nothing. */
const COMMAND_TOOLTIP_DELAY_MS = PIN_TOOLTIP_DELAY_MS

/**
 * What the hint line says while the completion list is up (canvas 9b's well).
 * The same in both mounts: with the list open, ⏎ is the list's in either one,
 * so the mount's own resting copy would be describing a key it does not have.
 */
const POPUP_HINT = '⏎ accept · esc closes the list · ⌘V paste image'

/**
 * The editable root. `orbital-composer-field` carries the formatted content's
 * look (theme.css); the rest is the field the textarea used to be: grows with
 * its content, then scrolls, accent caret. `tabindex` makes it focusable
 * where contenteditable alone is not (jsdom); a browser already treats it so.
 */
const FIELD_CLASS = `orbital-composer-field block min-h-[36px] w-full overflow-y-auto text-text-bright caret-accent focus:outline-none ${FIELD_METRICS}`

/**
 * The `/` or `@` token the caret is in, read off the text of the block it
 * sits in (spec § 3). `completionContext` stays the one rule for what counts;
 * this only maps its offsets onto the document. Code — a block or an inline
 * mark — completes nothing.
 */
function readCompletion(editor: Editor): CompletionContext | null {
  const { selection, schema } = editor.state
  if (!selection.empty) return null
  const { $from } = selection
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null
  if (schema.marks.code && $from.marks().some((m) => m.type === schema.marks.code)) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\n')
  const context = completionContext(before, before.length)
  if (!context) return null
  // `start` becomes a document position: the popup only reads the kind and
  // the prefix, and the accept replaces from here to the caret.
  return { ...context, start: $from.start() + context.start }
}

const sameCompletion = (a: CompletionContext | null, b: CompletionContext | null) =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.start === b.start && a.prefix === b.prefix)

/** The caret at the end of the document, the way a textarea's lands after its value is set. */
function caretToEnd(editor: Editor) {
  const { tr, doc } = editor.state
  editor.view.dispatch(tr.setSelection(Selection.atEnd(doc)))
}

export interface ComposerProps {
  /** Which session (panel) or directory (dialog) completions resolve against. */
  sessionKey: CompletionKey
  /** Markdown in both directions. */
  value: string
  onChange: (value: string) => void
  /** ⏎ sends in the panel, newlines in the dialog (canvas 9d). */
  enter: 'send' | 'newline'
  /** Called with the trimmed markdown when ⏎ sends. */
  onSend?: (text: string) => void
  /**
   * A completion that acts instead of being inserted — `/mcp` opens its
   * dialog straight from the popup (canvas `Feature - MCP dialog` 12d).
   * Returning true means it acted, and the accept inserts nothing.
   */
  actOnAccept?: (insert: string) => boolean
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
  /**
   * The session cannot take a message right now — it is compacting its
   * context (spec 2026-09-28-context-compaction-design § Transcript while it
   * runs). The field is read-only and the well quiets down (canvas 26c); the
   * caller supplies the placeholder that says why and keeps its own Send
   * inert.
   */
  locked?: boolean
  placeholder?: string
  id?: string
  'aria-label'?: string
  /** Rendered at the right end of the hint row — the panel's Stop/Send buttons. */
  actions?: ReactNode
  /**
   * A strip across the top of the well, above the text (canvas `Feature -
   * Rewind v2` 27a): pick mode's "Pick one of your messages" and a pending
   * rewind's "Rewound · N messages hidden". The caller draws its content; the
   * well draws the rule under it.
   */
  strip?: ReactNode
  /**
   * The well wears its focused chrome — accent .5 border and the 3px glow —
   * whether or not it has focus: a pending rewind (27a/27b), where the text in
   * it is what the next send makes permanent.
   */
  emphasized?: boolean
  /** The resting hint in the brighter ink pick mode and a pending rewind use (27a). */
  hintBright?: boolean
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
  actOnAccept,
  placement,
  variant,
  hint,
  answering = false,
  locked = false,
  placeholder,
  id,
  actions,
  strip,
  emphasized = false,
  hintBright = false,
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
  const popupRef = useRef<CompletionHandle | null>(null)

  const [focused, setFocused] = useState(false)
  const [context, setContext] = useState<CompletionContext | null>(null)
  const [activeDescendant, setActiveDescendant] = useState<string | null>(null)
  /** Escape closes the list without touching the text; it stays closed until
   * the token is left and re-entered. */
  const [dismissed, setDismissed] = useState(false)
  const [commands, setCommands] = useState<readonly SlashCommand[] | null>(null)
  /** Mentions whose path the server has confirmed — the tint is that receipt. */
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set())
  /** Paths already probed, so a path that does not exist is asked about once. */
  const probed = useRef<Set<string>>(new Set())

  // The Claude directory is part of the key: the dialog's catalog follows its choice.
  const keyId = 'session' in sessionKey ? `s:${sessionKey.session}` : `c:${sessionKey.claudeDir ?? ''}:${sessionKey.cwd}`

  // A different session or directory is a different catalog and a different
  // filesystem; nothing learned about the last one carries over.
  useEffect(() => {
    setCommands(null)
    setResolved(new Set())
    probed.current = new Set()
  }, [keyId])

  /** The mount's chip row. Memoised on the handle rather than rebuilt every
   * render, because the hint line's `useMemo` below depends on it. */
  const chips = useMemo(() => attachments?.items ?? [], [attachments?.items])
  const anyFailed = chips.some((chip) => chip.state === 'failed')
  const refusal = attachments?.refusal ?? null
  // The last chip that fits hides the placeholder, never the text (canvas
  // 9c-2): a full chip row plus a placeholder is two things competing for the
  // same line.
  const shownPlaceholder = chips.length >= MAX_ATTACHMENTS ? undefined : placeholder

  /**
   * What the editor's callbacks read. They are wired once, when the editor is
   * built, so anything that changes between renders reaches them through here.
   */
  const latest = useRef({ onChange, onSend, enter, attachments, placeholder: shownPlaceholder })
  latest.current = { onChange, onSend, enter, attachments, placeholder: shownPlaceholder }
  /** What the token paint reads — see `lib/composerDecorations`. */
  const tokenSource = useRef<TokenSource>({ known: new Set(), resolved: new Set(), hints: new Map() })
  /** The last markdown this field handed out; `value` equal to it is our own echo. */
  const lastEmitted = useRef(value)
  const keyDownRef = useRef<(e: KeyboardEvent) => boolean>(() => false)

  const [editorSetup] = useState(() => ({
    extensions: [
      ...composerSchemaExtensions(),
      Placeholder.configure({
        placeholder: () => latest.current.placeholder ?? '',
        // A locked field still says why it is locked (canvas 26c).
        showOnlyWhenEditable: false,
      }),
      Extension.create({
        name: 'composerTokens',
        addProseMirrorPlugins: () => [composerDecorationsPlugin(() => tokenSource.current)],
      }),
    ],
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        tabindex: '0',
        'data-composer-field': '',
        class: FIELD_CLASS,
        style: `max-height: ${MAX_FIELD_PX}px`,
      },
      handleKeyDown: (_view: EditorView, e: KeyboardEvent) => keyDownRef.current(e),
      handleDOMEvents: {
        // Ahead of ProseMirror's own paste, which would read a clipboard
        // carrying nothing but an image as an empty paste.
        paste: (view: EditorView, e: ClipboardEvent) => {
          const intake = latest.current.attachments
          const files = intake ? filesFrom(e.clipboardData) : []
          if (files.length > 0) intake!.accept(files, 'clipboard')
          const markdown = clipboardMarkdown(e.clipboardData)
          const editor = (view.dom as HTMLElement & { editor?: Editor }).editor
          const slice =
            markdown !== null && editor
              ? markdownPasteSlice(editor, view.state.schema, markdown, view.state.selection.$from)
              : null
          if (slice) {
            view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
            e.preventDefault()
            return true
          }
          // An image with no text beside it is a paste that is over; one that
          // came with text still pastes the text (canvas 9c).
          if (files.length > 0 && markdown === null && !e.clipboardData?.types?.includes('text/html')) {
            e.preventDefault()
            return true
          }
          return false
        },
      },
    },
  }))

  const editor = useEditor({
    ...editorSetup,
    content: lastEmitted.current,
    contentType: 'markdown',
    editable: !locked,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    // Pasted text is read as markdown by `clipboardMarkdown` and HTML by
    // ProseMirror; the marks' own paste rules would re-scan either with the
    // loose patterns the input rules were tightened away from.
    enablePasteRules: false,
    onUpdate: ({ editor }) => {
      const markdown = composerMarkdown(editor)
      if (markdown === lastEmitted.current) return
      lastEmitted.current = markdown
      latest.current.onChange(markdown)
    },
    onTransaction: ({ editor }) => {
      const next = readCompletion(editor)
      setContext((prev) => (sameCompletion(prev, next) ? prev : next))
    },
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  })

  // The caret starts where a textarea's would after its value was set: at
  // the end. Before paint, so a field that opens on a `/` fragment already
  // has its completion.
  useLayoutEffect(() => {
    if (!editor) return
    caretToEnd(editor)
    setContext(readCompletion(editor))
  }, [editor])

  // `value` from outside — a session switch, a cleared draft, a reset. Our
  // own echo is skipped, so typing never re-parses under the caret.
  useEffect(() => {
    if (!editor || value === lastEmitted.current) return
    lastEmitted.current = value
    editor.commands.setContent(parseComposerMarkdown(editor, value), { emitUpdate: false })
    caretToEnd(editor)
  }, [editor, value])

  useEffect(() => {
    if (editor && editor.isEditable === locked) editor.setEditable(!locked, false)
  }, [editor, locked])

  // The root is ProseMirror's element, so its ARIA wiring is set on it
  // directly rather than rendered.
  useLayoutEffect(() => {
    const dom = editor?.view.dom
    if (!dom) return
    const set = (name: string, next: string | undefined) =>
      next === undefined ? dom.removeAttribute(name) : dom.setAttribute(name, next)
    set('id', id)
    set('aria-label', aria['aria-label'])
    set('aria-placeholder', shownPlaceholder)
    set('aria-disabled', locked ? 'true' : undefined)
    set('aria-controls', activeDescendant ? listboxId : undefined)
    set('aria-activedescendant', activeDescendant ?? undefined)
  }, [editor, id, aria, shownPlaceholder, locked, activeDescendant, listboxId])

  /**
   * The list reports its active row, and it only has one while it is actually
   * painted — which makes this the popup's "on screen" flag as well as the
   * field's `aria-activedescendant`.
   */
  const popupShown = activeDescendant !== null

  /** The command whose file the skill viewer shows; the list stays shut under it. */
  const [viewingSkill, setViewingSkill] = useState<string | null>(null)
  const popupOpen = context !== null && !dismissed && viewingSkill === null
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

  // A tinted command explains itself on hover and opens on click (spec:
  // 2026-09-30-skill-preview-design). The tokens are editor decorations, not
  // React elements, so the well listens and reads the name back off
  // `data-command`.
  const commandsByName = useMemo(
    () => new Map((commands ?? []).map((c) => [c.name.replace(/^\//, ''), c])),
    [commands],
  )
  const [commandHover, setCommandHover] = useState<{ name: string; rect: DOMRect } | null>(null)
  const hoveredName = useRef<string | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearCommandHover = () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    hoveredName.current = null
    setCommandHover(null)
  }
  useEffect(() => () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
  }, [])
  const commandTokenAt = (target: EventTarget): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>('[data-command]') : null
  const handleWellMouseOver = (e: ReactMouseEvent) => {
    const token = commandTokenAt(e.target)
    const name = token?.dataset.command ?? null
    if (name === hoveredName.current) return
    clearCommandHover()
    if (!token || !name) return
    hoveredName.current = name
    hoverTimer.current = setTimeout(
      () => setCommandHover({ name, rect: token.getBoundingClientRect() }),
      COMMAND_TOOLTIP_DELAY_MS,
    )
  }
  const handleWellClick = (e: ReactMouseEvent) => {
    const name = commandTokenAt(e.target)?.dataset.command
    const command = name ? commandsByName.get(name) : undefined
    // A built-in has no file behind it: the tooltip is all there is (the
    // paint's `openable` makes the same call for the pointer cursor).
    if (!name || !command || command.source === 'built-in') return
    clearCommandHover()
    // Keystrokes must not land in the field behind the viewer.
    editor?.commands.blur()
    setViewingSkill(name)
  }
  const hoveredCommand = commandHover ? commandsByName.get(commandHover.name) : undefined
  const note = useMemo(() => {
    if (commands === null) return null
    const slug = unknownCommand(value, knownCommands)
    return slug === null ? null : `no command ${slug} — sends as typed`
  }, [commands, value, knownCommands])

  // The paint reads the catalog, the receipts and the hints; tell it when any
  // of them moved.
  useEffect(() => {
    const hints = new Map<string, string>()
    const openable = new Set<string>()
    for (const c of commands ?? []) {
      const name = c.name.startsWith('/') ? c.name.slice(1) : c.name
      if (c.argumentHint) hints.set(name, c.argumentHint)
      if (c.source !== 'built-in') openable.add(name)
    }
    tokenSource.current = { known: knownCommands, resolved, hints, openable }
    if (editor && !editor.isDestroyed) refreshDecorations(editor.view)
  }, [editor, commands, knownCommands, resolved])

  // A new placeholder has to be drawn; the plugin only looks on a transaction.
  useEffect(() => {
    if (editor && !editor.isDestroyed) refreshDecorations(editor.view)
  }, [editor, shownPlaceholder])

  /** Every mention in the text, in the order they were typed. */
  const mentions = useMemo(
    () =>
      tokenizeComposer(value, knownCommands).flatMap((token) =>
        token.kind === 'mention' ? [token.path] : [],
      ),
    [value, knownCommands],
  )

  /**
   * One unconfirmed mention at a time, debounced: `files/complete` on the whole
   * path answers with the directory's entries, and an entry whose name is the
   * path's own basename means the path exists. Each resolution re-renders and
   * the next unconfirmed mention takes its turn. The token being typed right
   * now is skipped — the popup is already asking about that one.
   */
  useEffect(() => {
    const typing = context?.kind === 'file' ? context.prefix : null
    const pending = mentions.find(
      (path) => !resolved.has(path) && !probed.current.has(path) && path !== typing,
    )
    if (!pending) return
    const timer = setTimeout(() => {
      probed.current.add(pending)
      api
        .filesComplete(sessionKey, pending)
        .then((entries) => {
          const dir = pending.slice(0, pending.lastIndexOf('/') + 1)
          // The row's own path, not its base name: with an editor connected
          // the list also carries open tabs matched by base name from
          // elsewhere in the tree (spec 2026-09-23-ide-bridge-design § Open
          // files), and one of those must not confirm a path that is not
          // there. `path` is sent only when it cannot be derived.
          // A path ending in `/` has no basename to match; a directory that
          // lists anything at all exists.
          const exists =
            dir === pending
              ? entries.length > 0
              : entries.some((e) => (e.path ?? dir + e.name) === pending)
          if (exists) setResolved((prev) => new Set(prev).add(pending))
        })
        .catch(() => {
          // Unconfirmed stays untinted. Nothing to report.
        })
    }, MENTION_PROBE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentions, resolved, context, keyId])

  const handleAccept = useCallback(
    (insert: string, keepOpen: boolean) => {
      if (context === null || !editor) return
      if (!keepOpen && actOnAccept?.(insert)) return
      // One trailing space on accept; a directory gets none, because the popup
      // stays open and keeps completing inside it (canvas 9b).
      const tail = keepOpen ? '' : ' '
      // Accepting a path IS the confirmation — no probe needed (spec:
      // "applied on popup accept").
      if (insert.startsWith('@')) setResolved((prev) => new Set(prev).add(insert.slice(1)))
      const { state } = editor
      editor.view.dispatch(state.tr.insertText(insert + tail, context.start, state.selection.from))
    },
    [context, editor, actOnAccept],
  )

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

  /**
   * The keys (spec § 2). The list gets first refusal on every key — it owns
   * ↑↓, ⏎ and Tab while it is on screen, and nothing else (spec § Completion
   * popup). Then `composer.send` and `composer.newline` mean what the mount
   * says; everything else is Tiptap's own — a bare ⏎ in the dialog splits the
   * block or the list item, Tab nests an item. `matches` wants the exact
   * modifier set, so ⌘⏎ — which belongs to whoever is listening further out,
   * the dialog's `composer.start` — is never one of these.
   */
  keyDownRef.current = (e: KeyboardEvent) => {
    if (popupRef.current?.handleKeyDown(e)) return true
    if (!editor) return false
    if (matches(command('composer.send').chords[0], e)) {
      if (enter !== 'send') return false
      const text = composerMarkdown(editor).trim()
      // An armed chip is a sendable turn on its own — an image with no words is
      // a whole message (spec § Send). Empty and unarmed still sends nothing.
      if (text || attachments?.armed) onSend?.(text)
      return true
    }
    if (matches(command('composer.newline').chords[0], e)) {
      if (enter === 'send') {
        // What a bare ⏎ does in the dialog: a new item in a list, a new line
        // in code, a new paragraph anywhere else.
        return editor.commands.first(({ commands: c }) => [
          () => c.splitListItem('listItem'),
          () => c.newlineInCode(),
          () => c.createParagraphNear(),
          () => c.liftEmptyBlock(),
          () => c.splitBlock(),
        ])
      }
      return editor.commands.first(({ commands: c }) => [() => c.newlineInCode(), () => c.setHardBreak()])
    }
    return false
  }

  return (
    <div className={className}>
      <div
        ref={wellRef}
        onMouseOver={handleWellMouseOver}
        onMouseLeave={clearCommandHover}
        onClick={handleWellClick}
        // Typing moves the text under a bubble that was placed for it.
        onKeyDown={clearCommandHover}
        data-composer-well
        data-focused={focused || undefined}
        // Canvas 9a/9e: 10px radius over rgba(4,8,16,.6) inside a .18
        // hairline; focus takes the accent at .5 plus a 3px accent .1 glow.
        // `--color-accent` is oklch(85% .12 205) precomputed (theme.css), which
        // is this feature's accent throughout. The column gap is the 10px both
        // wells carry (9c-2 and 9d-D) — chip row to text, text to hint line.
        data-locked={locked || undefined}
        className={[
          'relative flex flex-col gap-2.5 rounded-[10px] border transition-[border-color,background-color] duration-300',
          // 26c: a locked well drops to a .08 hairline over a .3 fill.
          locked ? 'bg-[rgba(4,8,16,.3)]' : 'bg-[rgba(4,8,16,.6)]',
          variant === 'dialog' ? 'min-h-24 px-3.5 pb-2.5 pt-3' : 'px-3 pb-2.5 pt-3',
          // 9c-1: the marker is 96px tall, so the panel's well grows to it for
          // the duration of the drag — the dialog's already is.
          dropArmed ? 'min-h-24' : '',
          // Canvas 9c COLOUR: "composer pending border — accent/.38 → .5
          // typed". The typed state is the same chrome focus already wears,
          // which is why they share a branch.
          locked
            ? 'border-[rgba(150,205,255,.08)]'
            : focused || emphasized || (answering && value.length > 0)
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

        {/* Canvas 27a: -2px above, a .1 hairline 10px under it; the 10px
            beneath the rule is the well's own gap. */}
        {strip && (
          <div
            data-composer-strip
            className="-mt-0.5 flex items-center gap-2 border-b border-[rgba(150,205,255,.1)] pb-2.5 font-mono text-[10.5px] text-[rgba(200,220,245,.85)]"
          >
            {strip}
          </div>
        )}

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
          <EditorContent editor={editor} />
        </div>

        {/* Hint row — 8px above, mono 10 at .06em (9e). Four states, in this
            order: the open list's own keys (9b), the refusal line (9d-C), the
            unknown-command note in the NOT IN CACHE voice (9a), then the
            mount's resting copy. The refusal REPLACES the hint in place, which
            is why it is a branch here and not a line of its own — nothing
            reflows when it arrives or leaves.

            A size container, so the actions can drop their words when the
            row runs short (a narrow detail panel) instead of wrapping. */}
        <div
          data-composer-hint
          // Nothing to say and nothing to hold: a mount whose controls live
          // elsewhere (the phone) can drop the row on this hook.
          data-empty={
            (!popupShown &&
              !refusal &&
              !note &&
              !locked &&
              !actions &&
              !(answering || hintBright ? hint : (ideHint ?? hint))) ||
            undefined
          }
          className="@container flex items-center gap-2"
        >
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
            <span
              className={[
                'font-mono text-[10px] tracking-[0.06em]',
                locked
                  ? 'text-[rgba(160,190,225,.25)]'
                  : hintBright
                    ? 'text-[rgba(200,220,245,.7)]'
                    : 'text-[rgba(160,190,225,.5)]',
              ].join(' ')}
            >
              {/* Pick mode and a pending rewind say what ⏎ does now; that outranks what it carries. */}
              {hintBright ? hint : (ideHint ?? hint)}
            </span>
          )}
          <span aria-hidden className="flex-1" />
          {locked && (
            <span data-composer-locked className="font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.25)]">
              LOCKED
            </span>
          )}
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

      {commandHover && hoveredCommand && !popupOpen && (
        <FloatingTooltip
          title={`/${commandHover.name}`}
          aside={sourceLabel(hoveredCommand.source, hoveredCommand.name)}
          description={hoveredCommand.description || undefined}
          rect={commandHover.rect}
        />
      )}
      <SkillViewer
        commandKey={sessionKey}
        name={viewingSkill}
        onClose={() => {
          setViewingSkill(null)
          editor?.commands.focus()
          // The click left the caret inside the slug; coming back to the
          // field is not asking to complete it.
          setDismissed(true)
        }}
      />
    </div>
  )
}
