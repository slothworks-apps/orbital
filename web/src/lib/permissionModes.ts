import type { PermissionMode } from './types'

/**
 * One permission mode as every Orbital surface consumes it.
 *
 * The picker (canvas 2d), the settings row (2f) and the detail-panel readout
 * (2d, 2e) all need the same four facts about a mode, in three different
 * lengths. Before this list they lived as two arrays inside `ModeCards`, and
 * the readout would have needed a third copy — which is how a picker and a
 * readout end up disagreeing about what `auto` does.
 */
export interface PermissionModeDescriptor {
  value: PermissionMode
  /** Raw SDK name, shown in mono. */
  label: string
  /** Shown instead of `label` where the column is narrow (settings, 320px). */
  shortLabel: string
  /** One line, picker and tooltip. */
  description: string
  /** One phrase, settings column. */
  shortDescription: string
  /**
   * Dot colour. Its own family, deeper and more chromatic than the tag
   * family's fixed `oklch(80% .13 H)` — see
   * `docs/decisions/mode-dots-are-their-own-hue-family.md`.
   */
  dot: string
}

/**
 * Every mode Orbital offers, ordered by escalating autonomy — which is also
 * the order the dot hues escalate in (green → blue → amber → red), so the
 * grid reads as a scale rather than as four labelled colours.
 *
 * Copy and colours transcribed from artboards 2d and 2e.
 *
 * The SDK also ships `default` and `dontAsk`. Neither is offered: `default`
 * is the CLI's ask-about-everything mode and Orbital always launches from a
 * picker where a choice has been made, and `dontAsk` is settings-only in
 * Claude Code and never picked per session.
 */
export const PERMISSION_MODES: readonly PermissionModeDescriptor[] = [
  {
    value: 'plan',
    label: 'plan',
    shortLabel: 'plan',
    description: 'Read-only. Proposes a plan before acting.',
    shortDescription: 'Read-only, plans first',
    dot: 'oklch(72% .17 148)',
  },
  {
    value: 'acceptEdits',
    label: 'acceptEdits',
    shortLabel: 'acceptEdits',
    description: 'Edits files freely; asks before shell commands.',
    shortDescription: 'Edits freely, asks for shell',
    dot: 'oklch(70% .16 255)',
  },
  {
    value: 'auto',
    label: 'auto',
    shortLabel: 'auto',
    description: 'Runs unattended; a classifier vets each command.',
    shortDescription: 'Unattended, vetted commands',
    dot: 'oklch(76% .16 85)',
  },
  {
    value: 'bypassPermissions',
    label: 'bypassPermissions',
    // The settings column is 320px wide; the full name does not fit beside
    // its dot at 11.5px mono without wrapping onto the description.
    shortLabel: 'bypass',
    description: 'Never asks. Sandboxed repos only.',
    shortDescription: 'Never asks',
    dot: 'oklch(66% .2 25)',
  },
]

/** The descriptor for a mode, or `undefined` for a value Orbital does not offer. */
export const permissionMode = (value: PermissionMode | null | undefined) =>
  PERMISSION_MODES.find((mode) => mode.value === value)
