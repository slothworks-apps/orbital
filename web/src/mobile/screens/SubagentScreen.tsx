import { MobileScreen } from '../ui'
import { pushedTop, useMobile } from '../state'

/**
 * A subagent's transcript, pushed over its session (canvas 10f; T3.1).
 * A placeholder until its track builds it: the header and its ‹.
 */
export function SubagentScreen() {
  const item = useMobile((s) => pushedTop(s, 'subagent'))
  const goBack = useMobile((s) => s.goBack)
  const header = (
    <div className="flex h-13 items-center gap-1 px-1.5">
      <button
        type="button"
        aria-label="Back to the session"
        onClick={() => goBack()}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] text-[28px] leading-none text-[rgba(220,235,255,.85)]"
      >
        ‹
      </button>
      <h1 className="min-w-0 flex-1 truncate pr-2 text-[16.5px] font-bold tracking-[-0.01em]">{item?.toolUseId}</h1>
    </div>
  )
  return <MobileScreen header={header}>{null}</MobileScreen>
}
