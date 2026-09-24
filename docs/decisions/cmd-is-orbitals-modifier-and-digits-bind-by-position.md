---
id: cmd-is-orbitals-modifier-and-digits-bind-by-position
title: ⌘ is Orbital's modifier; letters bind by character, digits by position
status: in-force
type: adr
domain: web
related:
  - 2026-09-23-shortcuts-design
  - new-session-shortcut-moves-to-option-n
  - desktop-wrapper-electron
tags:
  - shortcuts
  - desktop
---
# ⌘ is Orbital's modifier; letters bind by character, digits by position

## The problem

Orbital's first shortcuts were chosen for a browser tab: ⌘N is a new window
there, so new-session went to ⌥N, and ⌥ + letter on a Mac produces a
composed character (`˜`, `ƒ`), so the handlers matched the physical key
(`e.code`). On the keyboard Orbital is actually driven from — Czech QWERTZ —
that is wrong twice over: the physical `KeyZ` prints Y, and the digit row
prints `+ ě š č ř …` without Shift, so anything bound to a digit character
needs Shift. ⌘[ in the page bar was unreachable outright (`[` is under ⌥ on
that layout).

## The decision

The desktop app is the target, and it owns its menu, so **⌘ is Orbital's
modifier** the way it is in any native macOS app. ⌥ keeps one meaning,
"open this somewhere else" (⌥⏎, ⌥-click → IDE), and no ⌥ + letter chord
exists.

**Letters bind by character.** Cmd does not change the character a key
produces, so `⌘Z` is matched on `e.key === 'z'` and lands on the key that
prints Z wherever the layout puts it. **Digits bind by position.** Numpad
digits count too. They are matched on `e.code` (`Digit1`…), so ⌘1 is the
key labelled "+ 1" with no Shift. **Punctuation is limited to `,` and `.`**,
the two that sit where a US layout has them; `/ [ ] - = ;` are never used
in a default binding.

Three rules, no per-layout table, no cs/en switch.

## What was ruled out

- **⌥ as the app's modifier.** Only needed to dodge the browser's ⌘
  reservations, which do not apply in Electron; and it is the one family
  that forces `e.code` matching, which is exactly what breaks on QWERTZ.
  Making it work would need `navigator.keyboard.getLayoutMap()` to translate
  a mnemonic letter to a physical key — a runtime dependency for a problem
  the ⌘ family does not have.
- **Vim-style bare letters** (`n`, `f`, `j`/`k`). Layout-safe and fast, but
  a stray keystroke outside a text field runs an action, and outside the
  terminal world it is the least guessable scheme.
- **A cs/en layout switch.** With the rules above nothing differs between
  the layouts, so a switch would select between two identical tables.

## Consequences

- The keymap declares chords once and one `matches` function applies the
  rules; no component decides `key` vs `code` on its own.
- The Electron menu shows the same chords, generated from the keymap, so
  the two can never disagree.
- Web-in-a-browser is not a target: ⌘N and ⌘T are the browser's there and
  simply do not fire. The bindings are not chosen to survive that.
