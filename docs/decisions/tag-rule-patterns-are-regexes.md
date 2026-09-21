---
id: tag-rule-patterns-are-regexes
title: A path_matches pattern is a regex, matched anywhere in the path
status: in-force
type: adr
domain: tags
related:
  - tilde-expands-at-the-api-boundary
tags:
  - rules
  - paths
---
# A path_matches pattern is a regex, matched anywhere in the path

## The problem

`path_matches` patterns were globs (`*` within a segment, `**` across
segments), compiled to a regex anchored on both ends. Nothing in the UI said
so, and the syntax read as something else: Tomin wrote `/orbital/` expecting
"matches anywhere in the path" — a regex-literal spelling — and the rule
never fired, because the glob compiled to `^/orbital/$` and no session's cwd
is the literal string `/orbital/`. The author of the feature being unable to
guess its syntax from the input field is the feature telling on itself.

## The decision

The pattern is a JavaScript regex, tested **unanchored** against the
session's cwd (`new RegExp(pattern).test(cwd)`).

- `slothworks/orbital` matches any session under that project; anchoring is
  opted into with `^`/`$`, the way every regex user already expects.
- A leading `~/` (also directly after `^`) still expands to the home
  directory, regex-escaped, matching how paths are typed everywhere else in
  Orbital ([[tilde-expands-at-the-api-boundary]]).
- An **empty** pattern matches nothing — a freshly added rule (created with
  `pattern: ''`) must not grab every session. Under the anchored glob this
  fell out for free (`^$`); under an unanchored regex it has to be a rule,
  because `new RegExp('')` matches everything.
- A pattern that does not compile matches nothing instead of throwing. The
  pattern field flags it inline (red border, `aria-invalid`, the compile
  error as the tooltip) — a rule that silently never fires needs the reason
  to be visible where the pattern is typed.

## Ruled out

**Keeping globs and documenting them.** The glob dialect was homegrown and
anchored, so even a user who guessed "glob" would still be surprised by the
full-match requirement. Regex is the syntax the field's audience (a developer
running a local tool) guesses first.

**Supporting both, glob with a fallback to regex.** Two syntaxes in one
field means every pattern is ambiguous (`*` is legal in both with different
meanings), and the disambiguation rule would be the new thing nobody can
guess.

## Consequences

Existing rules stored as globs silently change meaning: `~/work/**` is now
an invalid regex (`Nothing to repeat`) and matches nothing until rewritten —
the UI flags it red the next time the row is opened, and the plain-prefix
form (`~/work/`) most rules want is shorter than the glob it replaces. A
local tool with one user; no migration.

`tags/rules.ts` stopped calling `expandHome` and expands the tilde itself,
because the expanded home directory must be regex-escaped before it is
spliced into the pattern — see the consequences note in
[[tilde-expands-at-the-api-boundary]].
