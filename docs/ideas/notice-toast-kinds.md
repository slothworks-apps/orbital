---
id: notice-toast-kinds
title: More kinds of notice in the toast queue — update, what's new, pairing, usage limit
status: backlog
type: idea
domain: app
related:
  - 2026-10-08-notifications-off-by-default-design
  - the-desktop-app-updates-itself
  - 2026-10-08-release-roadmap
  - 2026-10-08-builds-for-testers-design
tags:
  - notices
  - mobile
---
# More kinds of notice in the toast queue

[[2026-10-08-notifications-off-by-default-design]] built the shared notice
toast — one message at a time at the top centre of the map (the phone:
pinned above the session list), a queue in a fixed kind order, passive dots
for what is waiting, nothing auto-dismissing, each message seen once — with
one kind in it: the notifications-off tip. The canvas `Feature - Notice
toast.dc.html` (1a–1c, 2a–2d) draws four more:

- **Update** — on the desktop, built: it is the update prompt of
  [[2026-10-08-builds-for-testers-design]] (canvas `Feature - App
  update`), which replaced this sketch's "A new version is out" with
  states of its own. Left: the phone's "a new version is on TestFlight".
- **What's new** — after an update, three lines from the changelog and "See
  all changes", which opens a centred dialog (phone: a sheet) with the
  version's New / Changed / Fixed sections and a link to the release notes.
  Closing it ends the message. Drops out once a newer version is installed.
  Reads the app's own `CHANGELOG.md` section for the installed version.
- **Pairing / relay** — "Pixel 8 was paired with this Mac at 14:02. If that
  wasn't you, unpair it" on the Mac; "studio-mbp moved to a different relay;
  this phone followed it" on the phone.
- **Usage limit reset** — "Your usage limit reset at 15:00. auth-refactor
  and api-gateway carried on by themselves", with "Show them".

Out, as the canvas says: an inbox or history, snooze, promotional messages,
per-kind settings.
