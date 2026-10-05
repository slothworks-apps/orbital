import { MobileScreen } from '../ui'
import { pushedTop, useMobile } from '../state'

/**
 * An image or a text file the transcript named, pushed over its session (canvas 10d, 10e; T2.3, T2.4).
 * A placeholder until its track builds it: the header and its ‹.
 */
export function FileScreen() {
  const item = useMobile((s) => pushedTop(s, 'file'))
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
      <h1 className="min-w-0 flex-1 truncate pr-2 text-[16.5px] font-bold tracking-[-0.01em]">{item?.path ?? item?.ref}</h1>
    </div>
  )
  return <MobileScreen header={header}>{null}</MobileScreen>
}
