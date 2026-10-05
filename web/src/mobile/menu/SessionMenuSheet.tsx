import { useState, type ReactNode } from 'react'
import { api } from '../../lib/api'
import { reportError } from '../../lib/errors'
import { tagColor, type ApiSession } from '../../lib/types'
import { useOrbital } from '../../store/store'
import { useMobile } from '../state'
import { BottomSheet, ConfirmBody } from '../ui'
import { noteOutcome } from './MenuOutcome'
import { RenameSheet } from './RenameSheet'
import { carriesHarness, clearKeepsLines, endStopsLines, menuFor, type MenuItem } from './sessionMenu'
import { SHEET_LABEL, TagSheet } from './TagSheet'

type View = 'menu' | 'end' | 'clear' | 'rename' | 'tag'

/**
 * The ⋯ sheet (spec 2026-10-05-mobile-next § 4; canvas 10i, 10j): one
 * bottom sheet whose content swaps in place — the menu, End's and Clear's
 * confirms, Rename, Change tag. Rename, tag and pin write at once and roll
 * back with the composer's error line on failure, as the desktop panel does;
 * End and Clear only ever act from their confirm.
 */
export function SessionMenuSheet({
  session,
  offline,
  onClose,
}: {
  session: ApiSession
  offline: boolean
  onClose: () => void
}) {
  const [view, setView] = useState<View>('menu')
  const [busy, setBusy] = useState(false)
  const tags = useOrbital((s) => s.tags)
  const models = useOrbital((s) => s.models)
  const macName = useMobile((s) => s.macName)
  const id = session.id
  const tag = tags.find((t) => t.id === session.tagIds[0])
  const shape = menuFor(session, offline)
  const pinned = session.pinnedAt != null

  // The desktop panel's `commitTitle`: the store first, the old title back if the PATCH fails.
  const rename = (next: string) => {
    onClose()
    const previous = session.title
    patchSession(id, { title: next })
    api.renameSession(id, next).catch((err) => {
      patchSession(id, { title: previous })
      reportError(err, 'Failed to rename session')
    })
  }

  // The desktop panel's `selectTag`: one tag, replacing whatever the session wore.
  const pickTag = (tagId: number) => {
    onClose()
    const previous = session.tagIds
    if (previous.length === 1 && previous[0] === tagId) return
    patchSession(id, { tagIds: [tagId] })
    api.setSessionTags(id, [tagId]).catch((err) => {
      patchSession(id, { tagIds: previous })
      reportError(err, 'Failed to change the session tag')
    })
  }

  // The store's own pin: optimistic, rolled back with its toast.
  const togglePin = () => {
    onClose()
    void useOrbital.getState().setSessionPinned(id, !pinned)
  }

  const end = async () => {
    if (busy) return
    setBusy(true)
    try {
      await useOrbital.getState().endSession(id)
      noteOutcome({ sessionId: id, kind: 'ended' })
    } catch (err) {
      reportError(err, 'Failed to end the session')
    }
    onClose()
  }

  // `ClearDialog`'s Clear & start new, with its default: an unfinished harness goes on in the new session.
  const clear = async () => {
    if (busy) return
    setBusy(true)
    const carry = carriesHarness(useOrbital.getState().harnesses[id], session.harnessStep)
    try {
      const result = carry
        ? await api.clearSession(id, true, { carryHarness: true })
        : await api.clearSession(id, true)
      onClose()
      if (result.sessionId) {
        noteOutcome({ sessionId: result.sessionId, kind: 'cleared' })
        useMobile.getState().openSession(result.sessionId)
      }
    } catch (err) {
      reportError(err, 'Failed to clear session')
      onClose()
    }
  }

  const title = session.title || 'Untitled session'

  let body: ReactNode
  if (view === 'end') {
    const stops = endStopsLines(session, Date.now())
    body = (
      <ConfirmBody
        // Copy from canvas 10i End confirm, the desktop EndDialog's words with the phone's "Ended".
        eyebrow="/END"
        title="End this session?"
        body={
          <>
            <span className="font-mono text-text-bright">{title}</span> stops and moves to Ended — the transcript
            stays readable there.
          </>
        }
        detail={stops.length > 0 ? <Lines lines={stops} /> : undefined}
        confirmLabel="End session"
        onConfirm={() => void end()}
        onCancel={() => setView('menu')}
        busy={busy}
      />
    )
  } else if (view === 'clear') {
    body = (
      <ConfirmBody
        // Copy from canvas 10i Clear confirm.
        eyebrow="/CLEAR"
        title="Clear and start over?"
        body="The conversation is cleared and a fresh one starts in the same folder, tag, model and mode. The old transcript moves to Ended."
        detail={<Lines lines={clearKeepsLines(session, tags, models)} />}
        confirmLabel="Clear and start over"
        onConfirm={() => void clear()}
        onCancel={() => setView('menu')}
        busy={busy}
      />
    )
  } else if (view === 'rename') {
    body = <RenameSheet title={session.title} onSave={rename} onCancel={() => setView('menu')} />
  } else if (view === 'tag') {
    body = (
      <>
        <TagSheet tags={tags} currentId={tag?.id} onPick={pickTag} />
        <div className="h-4" />
      </>
    )
  } else {
    const rows: Record<MenuItem, ReactNode> = {
      rename: <Row key="rename" glyph={<span className="text-[rgba(200,220,245,.7)]">✎</span>} label="Rename" onPress={() => setView('rename')} />,
      tag: (
        <Row
          key="tag"
          glyph={<span className="block h-2 w-2 rounded-full" style={{ background: tag ? tagColor(tag.hue) : 'var(--state-neutral)' }} />}
          label="Change tag"
          hint={<span className="text-[rgba(160,190,225,.6)]">{tag ? `${tag.name} ›` : '›'}</span>}
          onPress={() => setView('tag')}
        />
      ),
      pin: (
        <Row
          key="pin"
          glyph={<PinGlyph />}
          label={pinned ? 'Unpin' : 'Pin to top'}
          hint={pinned ? <span className="text-[oklch(85%_.12_205)]">pinned</span> : undefined}
          onPress={togglePin}
        />
      ),
      clear: (
        <Row
          key="clear"
          glyph={<span className="text-[rgba(200,220,245,.7)]">↺</span>}
          label="Clear and start over"
          hint={<AsksFirst />}
          onPress={() => setView('clear')}
        />
      ),
      end: (
        <Row
          key="end"
          glyph={<span className="box-border block h-[9px] w-[9px] rounded-[1.5px] border-[1.5px] border-[rgba(200,220,245,.7)]" />}
          label="End session"
          hint={<AsksFirst />}
          onPress={() => setView('end')}
        />
      ),
    }
    const quick = shape.items.filter((item) => item === 'rename' || item === 'tag' || item === 'pin')
    const deliberate = shape.items.filter((item) => item === 'clear' || item === 'end')
    const list = (
      <>
        {quick.map((item) => rows[item])}
        {(deliberate.length > 0 || shape.terminalNote) && <div className="mx-2.5 my-1.5 h-px bg-[rgba(150,205,255,.1)]" />}
        {deliberate.map((item) => rows[item])}
      </>
    )
    body = (
      <>
        {shape.inert ? (
          // canvas 10j MAC ASLEEP: one sentence above the inert items.
          <div className="mx-2.5 mb-2.5 mt-0.5 flex min-h-11 items-center gap-2.5 rounded-[12px] border border-dashed border-[rgba(150,205,255,.18)] px-3 text-[13px] text-[rgba(160,190,225,.75)]">
            <span aria-hidden className="box-border block h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-[rgba(200,215,235,.6)]" />
            {macName ?? 'Your Mac'} is asleep — these wait for it
          </div>
        ) : (
          <div className={['truncate', SHEET_LABEL].join(' ')}>
            {shape.terminalNote ? `${title} · TERMINAL` : title}
          </div>
        )}
        {shape.inert ? (
          // canvas 10j MAC ASLEEP: the whole list at .4, nothing pressable.
          <fieldset disabled className="m-0 min-w-0 border-0 p-0 opacity-40">{list}</fieldset>
        ) : (
          list
        )}
        {shape.terminalNote && (
          // canvas 10j Terminal menu: where End and Clear live instead.
          <div className="flex gap-2.5 px-2.5 pb-1 pt-2.5 text-[12.5px] leading-[1.5] text-pretty text-[rgba(160,190,225,.7)]">
            <span className="mt-0.5 h-fit flex-none rounded-[4px] border border-[rgba(150,205,255,.2)] px-1.5 py-0.5 font-mono text-[9px] tracking-[0.12em]">
              READ-ONLY
            </span>
            Started in Terminal — end or clear it there. Orbital only labels it.
          </div>
        )}
        {/* canvas 10i, 10j: the space above the home indicator; the terminal sheet leaves more. */}
        <div className={shape.terminalNote ? 'h-[30px]' : 'h-4'} />
      </>
    )
  }

  return (
    <BottomSheet label={`${title} — session menu`} onDismiss={onClose}>
      {body}
    </BottomSheet>
  )
}

/** One session's optimistic write, a no-op once the store no longer holds it. */
function patchSession(id: string, fields: Partial<ApiSession>): void {
  useOrbital.setState((state) => {
    const current = state.sessions[id]
    if (!current) return state
    return { sessions: { ...state.sessions, [id]: { ...current, ...fields } } }
  })
}

/** canvas 10i: a 52 px menu row — the glyph in a 20 px column, the label, a mono hint at the end. */
function Row({ glyph, label, hint, onPress }: { glyph: ReactNode; label: string; hint?: ReactNode; onPress: () => void }) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="flex h-13 w-full items-center gap-3 rounded-[10px] px-2.5 text-left text-[15px] text-text-bright"
    >
      <span aria-hidden className="grid w-5 place-items-center text-center">{glyph}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="font-mono text-[11px]">{hint}</span>}
    </button>
  )
}

function AsksFirst() {
  return <span className="text-[rgba(160,190,225,.5)]">asks first</span>
}

/** canvas 10i: the pin — a ring on a short stem. */
function PinGlyph() {
  return (
    <span className="relative block h-3.5 w-5">
      <span className="absolute left-[6.5px] top-0 box-border block h-[7px] w-[7px] rounded-full border-[1.5px] border-[rgba(200,220,245,.75)]" />
      <span className="absolute left-[9.3px] top-[7px] block h-[7px] w-[1.4px] rounded-[1px] bg-[rgba(200,220,245,.75)]" />
    </span>
  )
}

/** The confirm's mono well, one line each (canvas 10i: "stops with it", "keeps"). */
function Lines({ lines }: { lines: string[] }) {
  // canvas 10i sets the well's lines at 1.7, a touch looser than 10b's.
  return (
    <div className="leading-[1.7]">
      {lines.map((line, at) => (
        <div key={at}>{line}</div>
      ))}
    </div>
  )
}
