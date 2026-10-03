import { useRef } from 'react'
import type { RefObject } from 'react'
import type { HarnessTemplate, Tag } from '../../lib/types'
import { MENU_SEPARATOR, MenuButton } from '../../ui/Menu'
import { groupTemplates, projectChips, scopeKey, stepsSummary, type ListFilter } from './logic'
import { ScopeMark, scopeName, SECONDARY_BUTTON, TagPill } from './parts'

const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_130px_190px_130px_24px] gap-4'

/** 30j's SHOW chips. */
function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        'rounded-full border px-2.5 py-1 font-mono text-[10.5px] transition-colors',
        active
          ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-text-bright'
          : 'border-[rgba(150,205,255,.14)] text-[rgba(160,190,225,.7)] hover:bg-white/5',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

/** The two header buttons, the same in the list and the empty state (30j, 30m). */
function HeaderButtons({
  draftRef,
  newRef,
  draftOpen,
  newOpen,
  onDraft,
  onNew,
}: {
  draftRef: RefObject<HTMLButtonElement | null>
  newRef: RefObject<HTMLButtonElement | null>
  draftOpen: boolean
  newOpen: boolean
  onDraft: () => void
  onNew: () => void
}) {
  return (
    <>
      <button ref={draftRef} type="button" aria-haspopup="dialog" aria-expanded={draftOpen} onClick={onDraft} className={SECONDARY_BUTTON}>
        Draft with the assistant…
      </button>
      <button
        ref={newRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={newOpen}
        onClick={onNew}
        // 30j at rest; 30m draws it lit while its scope popover is open.
        className={[
          'whitespace-nowrap rounded-lg border px-3 py-[7px] text-[12.5px] font-semibold transition-colors',
          newOpen
            ? 'border-accent/70 bg-accent/16 text-[oklch(90%_.09_205)]'
            : 'border-accent/60 bg-accent/10 text-[oklch(88%_.1_205)] hover:bg-accent/16',
        ].join(' ')}
      >
        + New template
      </button>
    </>
  )
}

function TemplateRow({
  template,
  tags,
  onEdit,
  onDuplicate,
  onMove,
  onDelete,
}: {
  template: HarnessTemplate
  tags: readonly Tag[]
  onEdit: () => void
  onDuplicate: () => void
  onMove: (anchor: HTMLElement) => void
  onDelete: () => void
}) {
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const hueOf = (name: string) => tags.find((t) => t.name === name)?.hue
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onEdit}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onEdit()
        }
      }}
      className={[COLUMNS, 'cursor-pointer items-center rounded-lg px-2.5 py-[9px] transition-colors hover:bg-[rgba(150,205,255,.05)]'].join(' ')}
    >
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[13px] font-semibold">{template.name}</span>
          {/* A conversation's draft, listed until Save (spec § 9); not in 30j, which draws none. */}
          {template.draft && (
            <span className="shrink-0 font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.55)]">draft · not saved</span>
          )}
        </div>
        <div className="mt-[3px] truncate text-[11.5px] text-[rgba(160,190,225,.65)]">{template.description}</div>
      </div>
      <span className="font-mono text-[10.5px] text-[rgba(200,220,245,.8)]">{stepsSummary(template.steps)}</span>
      <div className="flex flex-wrap gap-[5px]">
        {template.tags.length > 0 ? (
          template.tags.map((name) => <TagPill key={name} name={name} hue={hueOf(name)} size="row" />)
        ) : (
          <TagPill name={null} size="row" />
        )}
      </div>
      <span className="flex min-w-0 items-center gap-[7px] font-mono text-[10.5px] text-text-bright">
        <ScopeMark scope={template.scope} />
        <span className="truncate" title={template.scope.kind === 'project' ? template.scope.root : undefined}>
          {scopeName(template.scope)}
        </span>
      </span>
      <span ref={anchorRef} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <MenuButton
          aria-label={`${template.name} actions`}
          entries={[
            { key: 'edit', label: 'Edit', onSelect: onEdit },
            { key: 'duplicate', label: 'Duplicate', onSelect: onDuplicate },
            { key: 'move', label: 'Move to…', onSelect: () => anchorRef.current && onMove(anchorRef.current) },
            MENU_SEPARATOR,
            { key: 'delete', label: 'Delete…', onSelect: onDelete },
          ]}
          renderTrigger={(props) => (
            <button
              {...props}
              type="button"
              className="grid h-6 w-6 place-items-center rounded-md text-[rgba(160,190,225,.6)] hover:bg-white/5 hover:text-text-bright"
            >
              ⋯
            </button>
          )}
        />
      </span>
    </div>
  )
}

/**
 * 30j: the templates grouped by scope under a project filter; 30m when there
 * are none yet.
 */
export function TemplateList({
  templates,
  tags,
  filter,
  onFilter,
  headerButtons,
  onEdit,
  onDuplicate,
  onMove,
  onDelete,
}: {
  templates: readonly HarnessTemplate[] | null
  tags: readonly Tag[]
  filter: ListFilter
  onFilter: (filter: ListFilter) => void
  headerButtons: Parameters<typeof HeaderButtons>[0]
  onEdit: (t: HarnessTemplate) => void
  onDuplicate: (t: HarnessTemplate) => void
  onMove: (t: HarnessTemplate, anchor: HTMLElement) => void
  onDelete: (t: HarnessTemplate) => void
}) {
  if (templates !== null && templates.length === 0) {
    return (
      <div className="relative flex min-h-0 flex-col px-8 py-[18px]">
        <div className="flex items-start gap-3">
          <div className="flex-1" />
          <HeaderButtons {...headerButtons} />
        </div>
        {/* 30m: the step marks at rest, one sentence, no illustration. */}
        <div className="absolute inset-x-8 top-[150px] flex flex-col items-center gap-3 text-center">
          <div aria-hidden className="flex items-center gap-2.5">
            <span className="block h-2.5 w-2.5 rounded-full border-[1.4px] border-[rgba(160,190,225,.5)]" />
            <span className="block h-px w-6 bg-[rgba(150,205,255,.2)]" />
            <span className="block h-[9px] w-[9px] rotate-45 rounded-[1.5px] border-[1.4px] border-[rgba(160,190,225,.5)]" />
            <span className="block h-px w-6 bg-[rgba(150,205,255,.2)]" />
            <span className="block h-2.5 w-2.5 rounded-full border-[1.4px] border-[rgba(160,190,225,.5)]" />
          </div>
          <div className="text-[17px] font-bold">No harness templates yet</div>
          <div className="max-w-[440px] text-[12.5px] leading-[1.6] text-[rgba(160,190,225,.75)] [text-wrap:pretty]">
            A template is a list of steps for one kind of work, like “build a component” or “fix a bug with a failing test
            first”. Sessions can follow it and tick the steps off. Gates wait for your OK.
          </div>
          <div className="font-mono text-[10px] text-[rgba(160,190,225,.5)]">
            start from scratch with + New template, or describe it and let the assistant draft it
          </div>
        </div>
      </div>
    )
  }

  const chips = projectChips(templates ?? [])
  const groups = groupTemplates(templates ?? [], filter)
  return (
    <div className="flex min-h-0 flex-col gap-3.5 px-8 pb-5 pt-[18px]">
      <div className="flex items-start gap-3">
        <div className="flex-1 text-[12.5px] leading-[1.5] text-[rgba(160,190,225,.75)] [text-wrap:pretty]">
          Reusable step lists a session can follow. A global template is offered in every project; a project template only
          in its own.
        </div>
        <HeaderButtons {...headerButtons} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 font-mono text-[9.5px] tracking-[0.18em] text-[rgba(160,190,225,.55)]">SHOW</span>
        <FilterChip active={filter.kind === 'all'} onClick={() => onFilter({ kind: 'all' })}>
          All
        </FilterChip>
        <FilterChip active={filter.kind === 'global'} onClick={() => onFilter({ kind: 'global' })}>
          Global
        </FilterChip>
        {chips.map((p) => (
          <FilterChip
            key={p.root}
            active={scopeKey(filter) === `project:${p.root}`}
            onClick={() => onFilter({ kind: 'project', root: p.root })}
          >
            {p.name}
          </FilterChip>
        ))}
      </div>
      <div
        className={[
          COLUMNS,
          'border-b border-[rgba(150,205,255,.1)] px-2.5 pb-2 font-mono text-[9.5px] tracking-[0.18em] text-[rgba(160,190,225,.55)]',
        ].join(' ')}
      >
        <span>TEMPLATE</span>
        <span>STEPS</span>
        <span>TAGS</span>
        <span>SCOPE</span>
        <span />
      </div>
      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2 px-2.5 pb-1 pt-3 font-mono text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.6)]">
              {group.heading}
            </div>
            {group.templates.map((t) => (
              <TemplateRow
                key={t.id}
                template={t}
                tags={tags}
                onEdit={() => onEdit(t)}
                onDuplicate={() => onDuplicate(t)}
                onMove={(anchor) => onMove(t, anchor)}
                onDelete={() => onDelete(t)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
