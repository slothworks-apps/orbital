import { formatBytes } from '../../lib/format'
import { copyToClipboard } from '../../lib/clipboard'
import { StateButton } from './FileStates'

/**
 * A file the phone opened but cannot show (spec 2026-10-05-mobile-next § 2,
 * § 8 Decision 8): one plain line, the path and its size, and Copy path.
 * Nothing that opens or runs anything on the Mac.
 *
 * There is no artboard for it: it is canvas 10e's NOT AN IMAGE OR TEXT with
 * the "Open on <Mac>" action taken out, its type, inks and spacing kept. The
 * fidelity pass settles it.
 *
 * `outside` is the Mac's refusal of a path outside what the session may show
 * (spec § 2: "not on the phone", the desktop's OUTSIDE SESSION FOLDER).
 */
export function CantShow({ path, size, outside = false }: { path: string | null; size: number | null; outside?: boolean }) {
  const detail = [path, size !== null ? formatBytes(size) : null].filter(Boolean).join(' · ')
  return (
    <div className="flex flex-col justify-center gap-2.5 px-3.5">
      <span aria-hidden className="block h-[42px] w-[34px] rounded-[5px] border-[1.5px] border-[rgba(200,215,235,.45)]" />
      <span className="text-[13px] font-semibold">
        {outside ? 'Not on the phone — outside the session’s folder' : 'This file can’t be shown on the phone'}
      </span>
      {detail && <span className="break-all font-mono text-[10px] text-[rgba(160,190,225,.6)]">{detail}</span>}
      {path && (
        <StateButton quiet onClick={() => void copyToClipboard(path)}>
          Copy path
        </StateButton>
      )}
    </div>
  )
}
