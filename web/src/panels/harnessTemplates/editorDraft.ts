import { generateStepId } from '../../lib/harness'
import {
  DEFAULT_HARNESS_OPTIONS,
  type HarnessOptions,
  type HarnessStep,
  type HarnessTemplate,
  type HarnessTemplateBody,
  type TemplateScope,
} from '../../lib/types'

/** What the editor holds: a template's body with every option filled in. */
export type EditorDraft = Omit<HarnessTemplateBody, 'options' | 'scope' | 'draft'> & { options: HarnessOptions }

/** A model's draft or a stored template, as the editor holds it. */
export function toEditorDraft(
  t: Pick<HarnessTemplate, 'name' | 'description' | 'tags' | 'inputs' | 'steps'> & { options?: Partial<HarnessOptions> },
): EditorDraft {
  return {
    name: t.name,
    description: t.description,
    tags: t.tags,
    inputs: t.inputs,
    steps: t.steps,
    options: { ...DEFAULT_HARNESS_OPTIONS, ...t.options },
  }
}

export function newStep(taken: readonly string[]): HarnessStep {
  const title = `Step ${taken.length + 1}`
  return { id: generateStepId(title, taken), title, instructions: '', mode: 'auto', doneWhen: '' }
}

export function emptyDraft(): EditorDraft {
  return { name: '', description: '', tags: [], inputs: [], steps: [newStep([])], options: DEFAULT_HARNESS_OPTIONS }
}

/** The body the template routes take; `scope` without its display name. */
export function toBody(draft: EditorDraft, scope?: TemplateScope): HarnessTemplateBody {
  return {
    ...draft,
    ...(scope ? { scope: scope.kind === 'global' ? { kind: 'global' } : { kind: 'project', root: scope.root } } : {}),
  }
}

/** Compared through JSON: the draft is plain data, and key order follows the same constructors. */
export function sameDraft(a: EditorDraft, b: EditorDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
