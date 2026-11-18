/**
 * Every `--color-*` token of the web app's `theme.css` (spec
 * 2026-10-29-colour-tokens-design). Shared so that the server can hand a
 * generated view the same variables the web app draws with (spec
 * 2026-11-18-generated-views-design § Theme); `web/src/lib/palette.ts`
 * re-exports it, and a test there holds the list to `theme.css`.
 */

/** The one list: `Token` and the web's scene palette both come from it. */
export const TOKENS = [
  'space',
  'space-deep',
  'shade',
  'panel',
  'panel-solid',
  'raised',
  'line',
  'ink-50',
  'ink-100',
  'ink-200',
  'ink-300',
  'ink-400',
  'ink-500',
  'ink-600',
  'ink-700',
  'ink-800',
  'ink-900',
  'accent',
  'sky',
  'sky-soft',
  'warning',
  'warning-soft',
  'warning-deep',
  'success',
  'danger',
  'danger-soft',
  'danger-pale',
  'shadow',
  'highlight',
  'nebula-a',
  'nebula-b',
  'star',
  'body-hi',
  'body-mid',
  'body-lo',
  'body-idle-hi',
  'body-idle-lo',
  'body-ended',
  'void',
  'disc-off',
  'eclipse',
] as const;

export type Token = (typeof TOKENS)[number];
