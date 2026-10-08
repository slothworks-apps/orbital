# Privacy

Last updated: 8 October 2026

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
- **MCP servers** you add yourself are contacted by Claude Code at the
  addresses you give.
- **The relay**, if you turn on the phone app (below).

The Mac app has no automatic update check: it does not contact us or anyone
else to look for a new version.

## The phone and the relay

The phone app is optional. Nothing connects anywhere until you turn it on in
the Mac app's Settings → Mobile and enter a relay address. **There is no
default relay.** The relay is part of the open source code and ships as a
Docker image; whoever runs the relay you use holds the data described below.

**Pairing.** The Mac shows a QR code; the phone scans it with Google's ML Kit
barcode scanner and sends a one-time pairing request to the relay. You
confirm the phone on the Mac.

**What is end-to-end encrypted.** Everything about your sessions — the
session list, transcripts, files and images you open, messages you send,
photos you attach — travels between your phone and your Mac sealed with keys
only the two devices hold (signed X25519 key exchange, AES-256-GCM, fresh
keys for every connection). The relay passes these messages along and cannot
read them. It does not store them: a message for a phone that is offline is
dropped, because it could not be decrypted on the next connection anyway.

**What the relay can see and keep.** To route messages and send push
notifications, the relay stores, in its database:

- each device's public key (its ID) and whether it is a Mac or a phone;
- the phone's push token from Firebase Cloud Messaging, if you allowed
  notifications;
- when each device last connected;
- which phones are paired with which Mac, and when they were paired;
- the pairing codes it issued, with when they expire, whether they were
  used, and the public key of the phone that redeemed them.

It stores no names: not your Mac's name, not your phone's model or
platform. When you pair, your phone sends its model and platform to your
Mac encrypted with a key only the two of them hold; the relay passes them
on without being able to read them, and does not keep them.

It also sees, without storing them: when your devices are online, the
size and timing of the encrypted messages, and an anonymous token per
session that lets it count how many sessions are waiting for you without
knowing which ones. While a phone is offline it keeps up to a small, fixed
number of these tokens in memory, and forgets them when the phone
reconnects or the relay restarts. To limit abuse, it keeps the IP
addresses of recent pairing requests and refused connection attempts in
memory, never on disk. Its log lines contain only shortened IDs, states
and counts — never names, message contents, or full IDs or tokens.

**Push notifications** go through Google's Firebase Cloud Messaging (and,
on an iPhone, Apple's push service). They carry only the title "Orbital"
and how many sessions are waiting, for example "A session needs your
input" — no Mac name, no session title, nothing you wrote.

**How long the relay keeps it.** Unused pairing codes are deleted when they
expire. Everything else is kept until it is removed. Removing a phone in the
Mac app's Settings → Mobile deletes the pairing; "Pair a different Mac" on
the phone tells the relay to stop sending it push notifications. The device
records themselves (public key, push token, last seen) stay in the relay's
database until its operator deletes them.

**On the phone itself.** The phone keeps its pairing and its device key (in
the system's secure storage), and a cache of what you last saw — the session
list, the latest page of transcripts you opened, and a size-capped cache of
images and files — so the app has something to show while your Mac is
asleep. "Pair a different Mac" deletes all of it. The Android app opts out of Android's cloud backup. The phone asks
for the camera or your photos only when you choose to scan a code, take a
photo or pick one; a large photo is downscaled on the phone, and photos are
sent, encrypted, only to your Mac.

## Notifications

**On the Mac**, Orbital shows the system's own notifications when a session
needs your input, ends or fails. You choose which in Settings. They are
created on your Mac and go nowhere else.

**On the phone**, there are two kinds:

- **While the app is connected**, the phone builds notifications itself from
  the encrypted session data it receives, so they include the session's name.
  Nothing extra leaves your devices for these.
- **While the app is closed**, the relay sends a push notification through
  Google's Firebase Cloud Messaging; on iPhone, Google passes it on through
  Apple's push service. The push says "Orbital" and "A session needs your
  input" (or how many sessions do). It carries nothing else: no Mac name, no
  session names, no content. Which events trigger it follows the
  notification settings you choose for that phone. Google, and on iPhone
  Apple, handle the push under their own privacy terms.

The phone asks for permission to show notifications once it is paired. If you
decline, the app works without them and no push token is sent to the relay.
The phone app includes Firebase only for push messages: no Firebase
Analytics, no Crashlytics.

## Accounts and analytics

Orbital has no accounts. There is nothing to sign up for and nothing to log
in to, other than the Claude login you already use with Claude Code.

There are no analytics, no telemetry and no crash reporting in the Mac app,
the phone app or the relay. Orbital does not track how you use it, and it
does not show ads.

**This website** is a static site served by Cloudflare. It sets no cookies,
loads no analytics or tracking scripts, and loads its fonts from its own
server, so your browser does not contact anyone else. As the host,
Cloudflare processes your IP address and request details to deliver the page
and protect it from attacks, under Cloudflare's privacy policy.

## Open source

Orbital is open source under the MIT license:
[github.com/slothworks-apps/orbital](https://github.com/slothworks-apps/orbital).
Everything on this page can be checked against the code — the Mac app, the
phone app and the relay are all in that repository.

## Who is responsible

For this website, the data controller is:

SlothWorks s.r.o.\
Mostecká 232/4, 412 01 Litoměřice, Czech Republic\
Company ID (IČO): 107 98 838\
Email: orbital@slothworks.io

For everything that stays on your own Mac and phone, you are in control and
we receive nothing. The relay's data is held by whoever runs it. For your
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

You can also complain to the Czech data protection authority, the Úřad pro
ochranu osobních údajů ([uoou.gov.cz](https://uoou.gov.cz)), or the
authority in your own EU country.

## Changes and contact

When Orbital changes what it does with data, we update this page and the
date at the top. The full history of this page is in the public repository.

Questions about privacy: orbital@slothworks.io.
