# Privacy

Last updated: 11 November 2026

Orbital is built to keep your work on your own machines. This page says
exactly what the Mac app, the phone app, the relay and this website do with
your data, who else is involved, and how to get anything deleted. If
something here does not match what the code does, the code is public, and
we would like to hear about it.

Orbital is published by SlothWorks s.r.o. It is not made by, affiliated with
or endorsed by Anthropic.

## What runs where

**The Mac app** runs a small server on your Mac. It listens on `127.0.0.1`
only, so nothing else on your network can reach it, and every request to it
needs a token stored in Orbital's data folder (`~/Library/Application
Support/orbital`).

- It reads the session transcripts Claude Code writes under `~/.claude`. It
  never changes or deletes them.
- It keeps its own index of your sessions, your settings, and the images and
  files you attach to a session in that data folder. Images and attachments
  are kept under a size cap.
- When your phone shows an image a session names, the Mac makes a small
  preview of it for the phone and keeps it in that data folder for up to 30
  days.
- Settings → General → "Delete sessions older than" is off unless you turn it
  on. When on, it removes sessions from Orbital's index only; your Claude
  Code transcripts stay where they are.

**Your conversations with Claude** are carried out by Claude Code, through
Anthropic's Claude Agent SDK, signed in with your own Claude account. Orbital
itself does not send your prompts or code to anyone else. By default Orbital removes
`ANTHROPIC_API_KEY` from its own environment, so sessions use your Claude
subscription rather than an API key; it keeps the key only if you start it
with `ORBITAL_USE_API_KEY=1`. What Anthropic does with that traffic, and any
data Claude Code itself reports to Anthropic, is covered by Anthropic's
terms and privacy policy, not this one.

**Other connections the Mac app makes**, only when you ask for them:

- **Pull request status.** If you turn on the pull request badge in Settings
  (off by default), Orbital runs your own `gh` command-line tool, signed in
  with your own GitHub account, to look up the pull request for a branch.
  That request goes from your Mac to GitHub, under GitHub's terms.
- **Reports and feedback.** When you press Report on an error, or Send
  feedback in Settings, Orbital shows you the issue it would publish on
  Orbital's public GitHub repository, and nothing leaves your Mac until you
  press Create issue or Open on GitHub. Create issue runs your own `gh`,
  signed in with your GitHub account, and the issue is public under your
  name; Open on GitHub hands the same text to your browser instead. While
  you type the title, Orbital searches GitHub for issues with similar
  titles — through `gh`, or GitHub's public search without it — so the
  title you are writing reaches GitHub before you send it; the rest of the
  text does not. If you turn on Check reports with Claude (Labs) and press
  it, the draft and Orbital's newest issues go to Claude through your own
  Claude account, as any session would. On the phone, Send feedback opens
  GitHub's form in your browser with the app version, the system and the
  phone model filled in, and you send it there.
- **Logging in a profile.** When you press Log in or Sign in to Claude
  Design (on a lost-login notice or in Settings → Profiles), Orbital runs
  Claude Code's own sign-in, `claude auth login` or `claude design-login`,
  which talks to Anthropic as the same command does in a terminal, under
  Anthropic's terms. To show whether a profile is logged in, Orbital runs
  `claude auth status` and `claude design-login --status`, which read what
  Claude Code keeps on your Mac. Orbital keeps no copy of the account or
  its credentials. Logging in from your phone or another device of yours
  sends the code the sign-in page shows to your Mac, encrypted end to end
  like everything else between them; the profile's e-mail, organisation
  and plan go the other way, only to devices you gave the "Upkeep of this
  Mac" permission.
- **MCP servers** you add yourself are contacted by Claude Code at the
  addresses you give.
- **The relay**, if you turn on the phone app (below).

**Updates.** Since version 0.25.0 the Mac app checks for a new version when
it starts and every few hours, by asking GitHub for the latest release of
Orbital's public repository, and downloads it from there. GitHub sees what
it sees of any download from GitHub, such as your IP address. No Orbital
data goes with it, and nothing reaches us. Another device in your group can
start this update on your Mac; it goes the same way.

**Orbital on a Linux server.** If you install the `orbital` package on an
Ubuntu server, that server runs Orbital the way your Mac does, under your own
account, and keeps its data in your home folder there. Updates come through
the system's package manager from Orbital's package repository at
`apt.slothworks.io`, which is a set of static files: like any download, it sees
the server's IP address and which files it asks for, and nothing else. The
server reads the version it is offered from what the package manager has
already fetched; it does not contact the repository itself.

## Your devices and the relay

The phone app and a group of several Macs are optional. Nothing connects to
a relay until you turn it on in the Mac app's Settings → Devices and enter a
relay address. **There is no
default relay.** The relay is part of the open source code and ships as a
Docker image; whoever runs the relay you use holds the data described below. SlothWorks
runs no relay for the public: you run your own. A few testers use one that
SlothWorks runs, by arrangement; it holds what is described below and
nothing more.

**Pairing.** A device shows a code: a QR code the phone scans with Google's
ML Kit barcode scanner, or the same code as one word another Mac pastes. The
new device sends a one-time pairing request to the relay, and you confirm it
on the device that showed the code. The devices of one group - your Macs and
your phone - then pair with each other on their own: each asks the relay for
a pair with the other, signed with its own key, and the relay forms the pair
once both have asked.

**What is end-to-end encrypted.** Everything about your sessions - the
session list, transcripts, files and images you open, messages you send,
photos you attach - the list of devices in your group, and the settings and
tags your Macs share with each other travel between
two of your devices sealed with keys only those two devices hold (signed X25519 key exchange, AES-256-GCM, fresh
keys for every connection). The relay passes these messages along and cannot
read them. It does not store them: a message for a phone that is offline is
dropped, because it could not be decrypted on the next connection anyway.

**What the relay can see and keep.** To route messages and send push
notifications, the relay stores, in its database:

- each device's public key (its ID) and whether it last paired as the
  device showing a code or the one redeeming it;
- the phone's push token from Firebase Cloud Messaging, if you allowed
  notifications;
- when each device last connected;
- which of your devices are paired with which, and when they were paired;
- a request from one device to pair with another of your devices, until the
  other asks too or the request expires after a week;
- the pairing codes it issued, with when they expire, whether they were
  used, and the public key of the phone that redeemed them.

It stores no names: not your Mac's name, not your phone's model or
platform. When you pair, your phone sends its model and platform to your
Mac encrypted with a key only the two of them hold; the relay passes them
on without being able to read them, and does not keep them.

It also sees, without storing them: when your devices are online, the
size and timing of the encrypted messages, and an anonymous token per
session that lets a later notification for the same session replace the
earlier one, without the relay knowing which session it is. While a phone is offline it keeps up to a small, fixed
number of these tokens in memory, and forgets them when the phone
reconnects or the relay restarts. To limit abuse, it keeps the IP
addresses of recent pairing requests and refused connection attempts in
memory, never on disk. Its log lines contain only shortened IDs, states
and counts - never names, message contents, or full IDs or tokens.

**Push notifications** go through Google's Firebase Cloud Messaging (and,
on an iPhone, Apple's push service), and only from a relay that holds the
Firebase credentials of the Orbital phone app. A relay you run yourself
does not, so with it the phone shows notifications only while the app is
open, and sends no push through Google or Apple. They carry only the title "Orbital"
and the same fixed line every time, "A session has an update" - no Mac
name, no session title, nothing you wrote.

**How long the relay keeps it.** Unused pairing codes and pairing
requests are deleted when they expire. Everything else is kept until it is
removed. Removing a device in Settings → Devices, on any device of the group,
deletes its pairs; leaving the group on the phone tells the relay to stop
sending it push notifications. The device
records themselves (public key, push token, last seen) stay in the relay's
database until its operator deletes them.

**On your devices.** Each device keeps the list of devices in its group. The
phone keeps its device key (in the system's secure storage) and a cache of
what you last saw - the session list, the latest page of transcripts you
opened, and a size-capped cache of images and files - so the app has
something to show while a Mac is asleep; leaving the group deletes the
cache. A Mac keeps the last session list of every other device in its group,
and in memory what it last read of their sessions, so it can show them while
that device is asleep; removing a device deletes them. To show your plan
limits, a Mac sends the e-mail of each Claude account it is signed in to,
the account's plan and how much of each usage window is used to your other
devices and the phone, end-to-end encrypted like everything above. A Mac
keeps the last limits of every other device in its group in memory only,
and keeps its own readings of the usage windows on disk, to estimate when
a limit runs out; a reading is deleted once its window resets. The Android app opts out of Android's cloud backup. The phone asks
for the camera or your photos only when you choose to scan a code, take a
photo or pick one; a large photo is downscaled on the phone, and photos are
sent, encrypted, only to the device the session runs on.

## Updates for the phone app

The phone app from TestFlight or Google Play updates its own code over the
air, from Orbital's own update server at `beam.slothworks.io`, which
SlothWorks runs itself; no other update service is involved. Every update is
signed by Orbital's build system, and the app refuses one that is not.

**The update check.** When you open the app, and whenever it comes back to
the foreground, it asks the server whether there is a new version. This is
needed for updates and always happens. The request carries:

- a random install id that the app makes up for itself. It is not tied to
  you, your Apple or Google account or any other app. On Android it is
  deleted when you uninstall the app. On an iPhone it is kept in the
  phone's keychain, which iOS does not clear when an app is deleted, so a
  reinstall on the same iPhone reuses it; it is never copied to iCloud or
  to another device;
- the platform (Android or iOS) and the system's version;
- the app's version, and the version and build number of the app installed
  from the store;
- the version of the update component, the first characters of the public
  key updates are checked against, and the update channel (`production`,
  or `experimental` when Experimental updates are on for your devices);
- whether the app came from a store and whether it runs in an emulator.

**The update channel.** When Experimental updates are turned on or off on
your Mac, the phone tells the update server which channel it follows. That
request carries the same fields as the update check and the channel's
name; the server keeps nothing from it, and the phone remembers the
choice itself.

**Diagnostics.** With Settings → Send diagnostics on, the app also reports,
under the same install id:

- whether an update downloaded, installed or failed, and how long the app
  took to start;
- when the app comes to the foreground or goes to the background;
- that something went wrong, by its kind only: an error in the app's code,
  a file of the app that failed to load, a crash, a freeze or a low-memory
  exit, with the system's reason code and how much memory the app used;
- the phone's model.

The text of an error, stack traces, addresses inside the app and anything
from your sessions are never sent, with diagnostics on or off: only that an
error of a given kind happened.

Diagnostics are on unless you turn them off. When you turn them off, the
app stops sending these reports at once; a report it had already queued
just before may still go out. The update check stays.

None of it carries a name, account or location, or anything from your
sessions or your Mac. Like any server, the update server sees the IP address a request
comes from. SlothWorks uses all of this only to deliver updates and to see
whether they work.

## Notifications

**On the Mac**, Orbital shows the system's own notifications when a session
needs your input, ends or fails. You choose which in Settings. They are
created on your Mac and go nowhere else.

**On the phone**, there are two kinds:

- **While the app is connected**, the phone builds notifications itself from
  the encrypted session data it receives, so they include the session's name.
  Nothing extra leaves your devices for these.
- **While the app is closed**, a relay that holds the phone app's Firebase
  credentials sends a push notification through Google's Firebase Cloud
  Messaging; on iPhone, Google passes it on through Apple's push service. A
  relay you run yourself cannot, so with it there are no notifications while
  the app is closed. The push says "Orbital" and "A session has an
  update", the same for every session and every event. It carries nothing
  else: no Mac name, no session names, no content. Which events trigger it follows the
  notification settings you choose for that phone. Google, and on iPhone
  Apple, handle the push under their own privacy terms.

The phone asks for permission to show notifications only when you turn a
notification on. If you decline, the app works without them and no push
token is sent to the relay.

The phone app includes Firebase only for push messages: no Firebase
Analytics, no Crashlytics. Firebase starts with the app, whether or not
notifications are on: each time the app opens, it registers this
installation with Google's Firebase Cloud Messaging, which gives it a push
token and records an installation id, the phone's model, language, time
zone, system version and the app's version. Google handles this under its
own privacy terms. Nothing from your sessions is part of it.

## Accounts and analytics

Orbital has no accounts. There is nothing to sign up for and nothing to log
in to, other than the Claude login you already use with Claude Code.

There are no analytics, no telemetry and no crash reporting in the Mac app
or the relay, and none in the phone app beyond the diagnostics described
above, which you can turn off. Orbital does not track how you use it, and it does not show ads.

**This website** is a static site served by Cloudflare. It sets no cookies,
loads no analytics or tracking scripts, and loads its fonts from its own
server, so your browser does not contact anyone else. As the host,
Cloudflare processes your IP address and request details to deliver the page
and protect it from attacks, under Cloudflare's privacy policy.

## Open source

Orbital is open source under the MIT license:
[github.com/slothworks-apps/orbital](https://github.com/slothworks-apps/orbital).
Everything on this page can be checked against the code - the Mac app, the
phone app and the relay are all in that repository.

## Who is responsible

For this website and the phone app's update server, the data controller is:

SlothWorks s.r.o.\
Mostecká 232/4, 412 01 Litoměřice, Czech Republic\
Company ID (IČO): 107 98 838\
Email: orbital@slothworks.io

For everything that stays on your own Mac and phone, you are in control and
we receive nothing but the phone app's update checks and, unless you turn
them off, its diagnostics. The relay's data is held by whoever runs it. For your
Claude sessions, Anthropic is responsible for its own processing.

Push notifications are delivered by Google (Firebase Cloud Messaging) and,
on iPhone, Apple; this website is hosted by Cloudflare. Google, Apple and
Cloudflare may process data outside the EU; their own terms describe the
safeguards they use for that.

Orbital is a developer tool and is not directed at children.

## Your rights

Under the GDPR you can ask us for a copy of the data we hold about you, ask
us to correct it, delete it, or limit or stop how we use it, and to receive
it in a portable form. Write to orbital@slothworks.io; we answer within one month.

**Deleting the phone app's data.** The only data of yours that SlothWorks
holds is what the phone app sends to the update server: the install id, the
update checks and, with diagnostics on, the reports described under
[Updates for the phone app](#updates-for-the-phone-app). To have it deleted:

1. Write to orbital@slothworks.io with the subject "Delete my Orbital data",
   and say which phone it is about (its model and whether it runs Android or
   iOS) and roughly since when you have used the app.
2. We delete the update checks and diagnostics we can match to that phone,
   and tell you when it is done, within one month.

Nothing ties these records to your name, so a phone's model and dates are
all we can match them by. You can also stop them yourself: Settings → Send
diagnostics off stops the reports at once, and uninstalling the app on
Android deletes its install id, so nothing sent later can be joined to what
was sent before. Firebase's token and installation id are held by Google
under its own terms; your devices and pairs on a relay are held by whoever
runs that relay, and Remove device or Leave group deletes them there.

You can also complain to the Czech data protection authority, the Úřad pro
ochranu osobních údajů ([uoou.gov.cz](https://uoou.gov.cz)), or the
authority in your own EU country.

## Changes and contact

When Orbital changes what it does with data, we update this page and the
date at the top. The full history of this page is in the public repository.

Questions about privacy: orbital@slothworks.io.
