import { truncateMiddle } from '../../lib/format'
import type { ApiSession } from '../../lib/types'
import { treeList, treesHeadText, treesMoreText, whereFormOf } from '../../lib/whereForm'
import { BottomSheet } from '../ui'
import { ListMark } from './marks'

/** 2h's sheet row: the branch is middle-cut to this many characters (the desktop's tooltip cuts shorter). */
export const SHEET_BRANCH_CH = 26

/**
 * WORKTREES (canvas `Feature - Git worktree` 2h, WHY A SHEET; spec
 * 2026-10-07-live-working-tree-design, The phone): what the header's count
 * opens — the trees the session's running subagents work in, one block per
 * tree (its mark by its own git, the branch, the directory) and each
 * subagent's task under it, `TREES_LIST_MAX_ROWS` trees then "+N more".
 *
 * The phone's sheet shell, minus buttons: nothing here is an action. It reads
 * the session live, so rows come and go in place; when the last tree goes it
 * stays open and says so, and never closes by itself under the thumb (2h,
 * LIVE).
 */
export function TreesSheet({ session, onClose }: { session: ApiSession; onClose: () => void }) {
  const trees = session.otherTrees ?? []
  const form = whereFormOf(session.git, trees)
  const list = treeList(trees)
  const refs = new Map(trees.map((tree) => [tree.root, tree.git?.ref ?? '']))
  const title = session.title || 'Untitled session'

  // canvas 2h: the sheet's text sits 18 px in, the shell's 10 plus this block's 8.
  return (
    <BottomSheet label="Worktrees" onDismiss={onClose}>
      <div className="max-h-[70vh] overflow-y-auto px-2 pb-2">
        <div className="pt-1.5 font-mono text-[10px] tracking-[0.2em] text-[rgba(160,190,225,.6)]">WORKTREES</div>
        {form.kind === 'plain' ? (
          <div className="mt-2 text-[19px] font-bold tracking-[-0.01em]">No subagents in other worktrees</div>
        ) : (
          <>
            <div className="mt-2 text-[19px] font-bold tracking-[-0.01em]">{treesHeadText(form)}</div>
            <div className="mt-1.5 text-[13.5px] leading-[1.5] text-pretty text-[rgba(200,214,235,.75)]">
              Where the running subagents of {title} are working right now.
            </div>
            <ul className="mt-3 flex flex-col">
              {list.rows.map((row) => (
                <li key={row.root} className="flex flex-col gap-1.5 border-t border-[rgba(150,205,255,.08)] py-3">
                  <div className="flex items-center gap-2 whitespace-nowrap font-mono text-[12.5px]">
                    <ListMark mark={row.mark} />
                    <span className="min-w-0 flex-1 truncate text-text-bright">
                      {truncateMiddle(refs.get(row.root) ?? '', SHEET_BRANCH_CH)}
                    </span>
                    <span className="text-[11px] text-[rgba(160,190,225,.6)]">{row.dir}</span>
                  </div>
                  <div className="flex flex-col gap-[3px] pl-[21px]">
                    {row.agents.map((agent, i) => (
                      <span key={i} className="grid grid-cols-[10px_minmax(0,1fr)] text-[13.5px] leading-[1.4] text-[rgba(200,214,235,.85)]">
                        <span aria-hidden className="text-[rgba(160,190,225,.5)]">
                          ·
                        </span>
                        <span className="text-pretty">{agent}</span>
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            {list.more > 0 && (
              <div className="border-t border-[rgba(150,205,255,.08)] pb-0.5 pt-3 font-mono text-[12px] text-[rgba(160,190,225,.6)]">
                {treesMoreText(list.more)}
              </div>
            )}
          </>
        )}
      </div>
    </BottomSheet>
  )
}
