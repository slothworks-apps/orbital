---
id: answer-a-data-deletion-request
title: Answer a request to delete a phone's data
type: runbook
status: in-force
domain: mobile
related:
  - ship-the-phone-over-the-air
  - release-to-google-play
  - release-to-the-app-store
tags:
  - privacy
  - mobile
  - beam
---
# Answer a request to delete a phone's data

The privacy policy (`site/content/privacy.md` → Your rights, Deleting the
phone app's data) promises this: a user sends the install ID from the phone
app's Settings → About to `orbital@slothworks.io` with the subject "Delete my
Orbital data", and SlothWorks deletes what the update server holds under it
and replies within one month. Google Play's Data safety form links that
section as the app's deletion URL.

## What there is to delete

Only Beam, the update server at `beam.slothworks.io`, holds data from the
phone. It files it under the updater plugin's install id (`deviceId`, a
lowercase UUID v4), which is what Settings → About shows:

- `device_events`: every update check, download, install and failure;
- `device_identities`: one row per install, with the phone's model and system
  version;
- `device_assignments`: a channel pinned to that install by hand, if any.

Beam deletes events and installs on its own after 90 days, and keeps only
daily totals with no id (Beam's `docs/state.md`). Everything else the policy
names is not SlothWorks' to delete: Firebase's token and installation id are
Google's, and a relay's devices and pairs belong to whoever runs it.

## Steps

1. **Check the id.** It must be a UUID (36 characters, five groups). A
   request without one cannot be matched: reply that nothing ties the data
   to a person without it, and that it is deleted on its own within 90 days.
2. **Delete it in Beam.** Use Beam's own way to delete one install if it
   has one (Beam's `DEPLOY.md`). Otherwise, in MongoDB Compass on the `beam`
   database (the connection is in `slothworks-infra` → `docs/infrastructure.md`),
   with the app's id in Beam and the install id:

   ```js
   const q = { app: '<Beam app id of Orbital>', deviceId: '<install id>' }
   db.device_events.deleteMany(q)
   db.device_identities.deleteMany(q)
   db.device_assignments.deleteMany({ app: q.app, identity: q.deviceId })
   ```

   Zero deleted documents is a valid answer: the install may never have
   checked in, or Beam may already have removed it.
3. **Reply** within one month of the request: what was deleted (update
   checks and diagnostics under that id), that Beam's backups keep a copy
   for up to three months before they expire, and that turning off Settings
   → Send diagnostics stops new reports.
4. **Keep nothing** from the request beyond the e-mail thread itself.
