import { useEffect, useRef, useState } from 'react'
import { modelNameForId } from '../../lib/models'
import { ELAPSED_TICK_MS, subagentModelFrom, taskStateFor } from '../../lib/subagentPanel'
import { tagColor, type ChatMessage, type Subagent } from '../../lib/types'
import { useNow } from '../../lib/useNow'
import { TranscriptView } from '../../panels/TranscriptView'
import { useOrbital } from '../../store/store'
import { isMacAsleep, pushedTop, useMobile } from '../state'
import { subagentBody, subagentHeader, INK, type SubagentHeader } from '../subagents/model'
import { MobileScreen, SecondaryButton } from '../ui'

const NO_MESSAGES: ChatMessage[] = []

/**
 * A subagent's transcript, pushed over its session (canvas 10f, 10h; spec
 * 2026-10-05-mobile-next § 3). Read-only: TASK FROM its parent, its rows as
 * 9b draws them, and once it has ended the RESULT it returned. The store's
 * `openSubagent` reads its newest `PHONE_SUBAGENT_PAGE` messages and follows
 * its topic while this screen is up.
 */
export function SubagentScreen() {
  const item = useMobile((s) => pushedTop(s, 'subagent'))
  return item ? <SubagentView key={`${item.sessionId}:${item.toolUseId}`} sessionId={item.sessionId} toolUseId={item.toolUseId} /> : null
}

function SubagentView({ sessionId, toolUseId }: { sessionId: string; toolUseId: string }) {
  const parent = useOrbital((s) => s.sessions[sessionId])
  const live = useOrbital((s) => s.sessions[sessionId]?.subagents.find((a) => a.toolUseId === toolUseId))
  const panel = useOrbital((s) =>
    s.subagentPanel?.sessionId === sessionId && s.subagentPanel.subagent.toolUseId === toolUseId ? s.subagentPanel : null,
  )
  const parentMessages = useOrbital((s) => s.transcripts[sessionId] ?? NO_MESSAGES)
  const models = useOrbital((s) => s.models)
  const tag = useOrbital((s) => (parent ? s.tags.find((t) => t.id === parent.tagIds[0]) : undefined))
  const openSubagent = useOrbital((s) => s.openSubagent)
  const closeSubagent = useOrbital((s) => s.closeSubagent)
  const offline = useMobile(isMacAsleep)
  const asOf = useMobile((s) => s.asOf)
  const goBack = useMobile((s) => s.goBack)
  const openSession = useMobile((s) => s.openSession)

  // The last reading of this agent, for when the session's list no longer
  // carries it (an ended session's republish, a restart): an ended agent must
  // not read as running again (the desktop panel keeps the same rule).
  const lastKnown = useRef<Subagent | undefined>(undefined)
  if (live) lastKnown.current = live
  const agent = live ?? lastKnown.current ?? panel?.subagent

  // Open once the moon is known, close on the way out. Opening again on the
  // way back from a file is the store's own reread.
  const known = agent !== undefined
  useEffect(() => {
    if (!known) return
    const current = useOrbital.getState().sessions[sessionId]?.subagents.find((a) => a.toolUseId === toolUseId)
    if (current) void openSubagent(sessionId, current)
    return () => {
      const open = useOrbital.getState().subagentPanel
      if (open?.sessionId === sessionId && open.subagent.toolUseId === toolUseId) closeSubagent()
    }
  }, [known, sessionId, toolUseId, openSubagent, closeSubagent])

  const running = agent !== undefined && agent.state !== 'ended'
  const now = useNow(running && !offline, ELAPSED_TICK_MS)

  const parentTitle = parent?.title || 'Untitled session'
  const messages = panel?.messages ?? NO_MESSAGES
  // A moon the Mac no longer lists, with no buffer either, has nothing to
  // show: STREAM LOST, under the only name it still has.
  const found = agent !== undefined && (panel?.found ?? true)
  const header: SubagentHeader = subagentHeader({
    agent: agent ?? { id: toolUseId, name: 'Subagent', state: 'ended', startedAt: 0, toolUseId },
    found, messages, offline, asOf, now,
  })
  const body = subagentBody(messages, parentMessages, toolUseId, !running)
  const rawModel = subagentModelFrom(messages)
  const model = rawModel ? modelNameForId(rawModel, models) : undefined
  const tagHue = tag ? tagColor(tag.hue) : 'var(--state-neutral)'

  const head = (
    <div className="px-1.5 pb-0.5">
      {/* canvas 10f: ‹ · moon dot in the tag hue · name over "subagent of <parent> · model". */}
      <div className="flex h-13 items-center gap-1">
        <button
          type="button"
          aria-label={`Back to ${parentTitle}`}
          onClick={() => goBack()}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] text-[28px] leading-none text-[rgba(220,235,255,.85)]"
        >
          ‹
        </button>
        <span
          aria-hidden
          className="mr-1 box-border block h-2.5 w-2.5 shrink-0 rounded-full border bg-[oklch(30%_.05_220)]"
          style={{ borderColor: tagHue }}
        />
        <div className="min-w-0 flex-1 pr-2">
          <h1 className="truncate text-[16.5px] font-bold">{agent?.name ?? 'Subagent'}</h1>
          <div className="mt-0.5 truncate font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
            subagent of {parentTitle}
            {model && ` · ${model}`}
          </div>
        </div>
      </div>
      {/* canvas 10f: the state, "ended hh:mm" once done, READ-ONLY at the end. */}
      <div className="flex h-11 items-center gap-2.5 pl-2.5 pr-3.5">
        <span className="flex items-center gap-[7px] font-mono text-[10.5px] tracking-[0.1em]" style={{ color: header.ink }}>
          {header.pulse && <span aria-hidden className="orbital-pulse block h-[7px] w-[7px] rounded-full" style={{ background: header.ink }} />}
          {header.word}
        </span>
        {header.ended && <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">{header.ended}</span>}
        <span aria-hidden className="flex-1" />
        <span className="rounded-[4px] border border-[rgba(150,205,255,.2)] px-1.5 py-0.5 font-mono text-[9px] tracking-[0.12em] text-[rgba(160,190,225,.75)]">
          READ-ONLY
        </span>
      </div>
    </div>
  )

  const completed = agent !== undefined && taskStateFor(agent, found) === 'completed'
  const tail = (
    <div className="flex flex-col gap-3 pb-3">
      {body.result !== null && (
        // canvas 10f done: the agent's last words, as its parent received them.
        <div
          className="rounded-[10px] border bg-[rgba(4,8,16,.45)] p-3"
          style={{ borderColor: completed ? 'rgba(127,227,176,.3)' : 'rgba(150,205,255,.12)' }}
        >
          <div className="font-mono text-[9.5px] tracking-[0.16em]" style={{ color: completed ? INK.done : header.ink }}>
            RESULT · RETURNED TO {parentTitle}
          </div>
          <div className="mt-1.5 whitespace-pre-wrap text-pretty text-[13.5px] leading-[1.5] text-[rgba(232,238,248,.92)]">
            {body.result}
          </div>
        </div>
      )}
      {header.end &&
        (header.end.divider ? (
          // canvas 10f END OF SUBAGENT; 10h's asleep line drawn as 9b's divider.
          <div className="flex items-center gap-2.5 font-mono text-[10px] tracking-[0.12em] text-[rgba(160,190,225,.5)]">
            <span aria-hidden className="h-px flex-1 bg-[rgba(150,205,255,.12)]" />
            {header.end.text.toUpperCase()}
            <span aria-hidden className="h-px flex-1 bg-[rgba(150,205,255,.12)]" />
          </div>
        ) : (
          <div className="font-mono text-[11px]" style={{ color: header.end.ink }}>
            {header.end.text}
          </div>
        ))}
    </div>
  )

  const footer = (
    // canvas 10f: no composer — where the result goes, and the way to the parent.
    <div className="flex flex-col gap-2 border-t border-[rgba(150,205,255,.1)] bg-[rgba(6,10,20,.94)] px-4 pb-1.5 pt-2.5">
      {running && (
        <div className="font-mono text-[11px] leading-[1.5] text-[rgba(160,190,225,.7)]">
          Subagents take no replies — its result goes back to {parentTitle}.
        </div>
      )}
      <SecondaryButton variant="sheet" onClick={() => openSession(sessionId)}>
        Open {parentTitle}
      </SecondaryButton>
    </div>
  )

  return (
    <MobileScreen header={head} footer={footer} scroll={false}>
      {body.task !== null && <TaskFrom parentTitle={parentTitle} text={body.task} dropped={panel?.droppedCount ?? 0} />}
      <TranscriptView
        messages={found ? body.rows : NO_MESSAGES}
        isWorking={running && !offline}
        models={models}
        resetKey={`${sessionId}:${toolUseId}`}
        sessionId={sessionId}
        surface="phone"
        // A subagent takes no input, whatever the parent has parked.
        readOnly
        footer={tail}
        footerKey={`${header.word}|${body.result !== null}`}
      />
    </MobileScreen>
  )
}

/**
 * canvas 10f: TASK FROM <parent>, the prompt the agent was given. It stays
 * above the rows rather than scrolling away, folded to its first lines until
 * pressed, since a prompt can run long. When the phone's page does not reach
 * back to the agent's first steps, it says how many came before.
 */
function TaskFrom({ parentTitle, text, dropped }: { parentTitle: string; text: string; dropped: number }) {
  const [full, setFull] = useState(false)
  return (
    <div className="shrink-0 px-3.5 pt-3">
      <button
        type="button"
        aria-expanded={full}
        onClick={() => setFull((v) => !v)}
        className="block w-full rounded-[10px] border border-[rgba(150,205,255,.12)] bg-[rgba(4,8,16,.45)] px-3 py-2.5 text-left"
      >
        <div className="font-mono text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.55)]">TASK FROM {parentTitle}</div>
        <div
          className={[
            'mt-1.5 whitespace-pre-wrap text-pretty text-[13px] leading-[1.5] text-[rgba(220,232,248,.9)]',
            full ? 'max-h-[40vh] overflow-y-auto' : 'line-clamp-3',
          ].join(' ')}
        >
          {text}
        </div>
      </button>
      {dropped > 0 && (
        <div className="pt-2 font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.5)]">
          {dropped.toLocaleString()} earlier {dropped === 1 ? 'step' : 'steps'} not shown
        </div>
      )}
    </div>
  )
}
