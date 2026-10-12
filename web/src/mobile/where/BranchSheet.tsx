import { prUrlText } from '../../lib/branchStatus'
import type { ApiSession } from '../../lib/types'
import { LinesTooltipContent, PrRows } from '../../panels/BranchSuffixes'
import { StateButton } from '../files/FileStates'
import { basename } from '../format'
import { BottomSheet } from '../ui'

const RULE = 'border-t border-[rgba(150,205,255,.08)]'

/**
 * BRANCH: what the header's branch opens on the phone — the desktop's branch,
 * line-change and pull-request tooltips (canvas `Feature - Branch status`
 * 1e) gathered in one sheet, the way the context readout opens its sheet.
 * The one action is opening the pull request on GitHub, which the system
 * browser does. Line changes and the PR are there only while their switches
 * are on in the Mac's Settings, as on the desktop.
 */
export function BranchSheet({ session, mac, onClose }: { session: ApiSession; mac: string; onClose: () => void }) {
  const git = session.git
  if (!git) return null
  const { lines, pr } = session.branch ?? {}
  const where = [basename(session.cwd), git.worktree ? 'worktree' : 'main checkout', git.detached ? 'detached HEAD' : null]
    .filter(Boolean)
    .join(' · ')

  // The sheet's text sits 16 px in, the shell's 10 plus this block's 6, as the context sheet's does.
  return (
    <BottomSheet label="Branch" onDismiss={onClose}>
      <div className="flex max-h-[70vh] flex-col gap-3.5 overflow-y-auto px-1.5 pb-1">
        <div>
          <div className="font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.6)]">BRANCH</div>
          <div className="mt-2 font-mono text-[15px] leading-[1.4] text-text-bright [overflow-wrap:anywhere]">{git.ref}</div>
          <div className="mt-1 font-mono text-[10px] text-[rgba(160,190,225,.5)]">{where}</div>
        </div>
        {lines && (
          <div className={`${RULE} pt-3.5`}>
            <LinesTooltipContent lines={lines} branch={git.ref} detached={git.detached} />
          </div>
        )}
        {pr && (
          <div className={`${RULE} flex flex-col gap-2.5 pt-3.5`}>
            <span className="font-mono text-[11px] text-text-bright">Pull request #{pr.number}</span>
            <PrRows pr={pr} />
            <StateButton onClick={() => window.open(pr.url, '_blank', 'noopener')}>Open on GitHub</StateButton>
            <span className="font-mono text-[10px] text-[rgba(160,190,225,.5)] [overflow-wrap:anywhere]">{prUrlText(pr.url)}</span>
          </div>
        )}
        {!session.branch && (
          <div className={`${RULE} pt-3.5 text-[12px] leading-[1.5] text-pretty text-[rgba(160,190,225,.75)]`}>
            Line changes and the pull request show here when they are on in Settings → Appearance on {mac}.
          </div>
        )}
      </div>
    </BottomSheet>
  )
}
