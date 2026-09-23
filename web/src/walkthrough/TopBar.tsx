import { shortenPath } from '../lib/format'
import type { ApiSession } from '../lib/types'
import { mapHref } from './route'
import { midTurn, statusWord } from './derive'

/**
 * The row every walkthrough screen opens with (canvas 21a/21b/21e): the way
 * back to the map (named after the session, since that is where it goes),
 * the crumb, and on the right the project and the session's status — plus,
 * while the session is mid-turn, the notice that the walkthrough may grow
 * under the reader (spec § The page, "A live session grows under the page").
 */
export function TopBar({ id, session, crumb }: { id: string; session: ApiSession; crumb?: string }) {
  const working = session.status === 'working'
  return (
    <header className="flex h-14 shrink-0 items-center gap-[14px] border-b border-[rgba(150,205,255,.08)] px-7 font-mono text-[11px] text-text-muted">
      <a href={mapHref(id)} className="truncate text-text-soft hover:underline">
        ← {session.title}
      </a>
      <Sep />
      <span className="text-[10px] tracking-[.18em]">WALKTHROUGH</span>
      {crumb && (
        <>
          <Sep />
          <span className="text-text-bright">{crumb}</span>
        </>
      )}
      <span className="flex-1" />
      {midTurn(session) && <span className="text-[rgba(160,190,225,.5)]">session working · steps may be added</span>}
      <span className="shrink-0">{shortenPath(session.cwd)}</span>
      <span
        className={[
          'inline-flex shrink-0 items-center gap-1.5 rounded-[5px] border px-[9px] py-1 text-[10.5px] tracking-[.08em]',
          working
            ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.1)] text-text-bright'
            : 'border-[rgba(150,205,255,.2)] text-[rgba(200,220,245,.7)]',
        ].join(' ')}
      >
        {working ? (
          <span aria-hidden className="block h-1.5 w-1.5 animate-pulse rounded-full bg-text-bright" />
        ) : (
          <span aria-hidden className="block h-1.5 w-1.5 rounded-full bg-[rgba(160,190,225,.5)]" />
        )}
        {statusWord(session)}
      </span>
    </header>
  )
}

function Sep() {
  return <span className="text-[rgba(150,205,255,.25)]">/</span>
}
