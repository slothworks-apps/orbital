# Orbital on Google Play: listing, Data safety and review material

What goes into Play Console for the Android app (`io.slothworks.orbital.mobile`).
The steps that use it are in the runbook `docs/ops/release-to-google-play.md`.
The privacy reasoning behind every answer is in `mobile/store/app-store.md` →
App Privacy, written from the code; this file maps it onto Play's forms. When
the two disagree, the code decides, then both files change.

Character counts were measured on the text between the markers below (Unicode
characters, `node` `[...s].length`). Recount after an edit:

```bash
node -e 'const t=require("fs").readFileSync("mobile/store/google-play.md","utf8");for(const m of t.matchAll(/<!-- (\S+) -->\n```text\n([\s\S]*?)\n```/g))console.log(m[1],[...m[2]].length)'
```

## Main store listing

English (United States), the only language.

### App name — limit 30

<!-- name -->
```text
Orbital by SlothWorks
```

The same as on the App Store. The name under the launcher icon is the app's
own `app_name`, `Orbital`.

### Short description — limit 80

<!-- short -->
```text
Follow, answer and start the coding sessions on your Mac, from your phone.
```

No "Claude" (Play's metadata policy, like Apple's 2.3.7): the full description
names it only to say what the app works with.

### Full description — limit 4000

The App Store description with the phone words changed: no iPhone, Face ID or
Safari.

<!-- description -->
```text
Orbital shows the Claude Code sessions running on your Mac on your phone: which are working, which are waiting for your input and which are done. Answer the ones that need you and start new ones while you are away from your desk.

The Android app is a companion to Orbital for Mac and does nothing on its own. You need:

• Orbital for Mac, a free download from orbital.slothworks.io, on a Mac with Apple silicon, with the Claude Code command-line tool installed and signed in to your own Claude account. A Linux server running Orbital works too.
• A relay that connects the phone to your Mac, which you run yourself on a server of your own. It is open source and ships as a Docker image.

Pairing is one scan: open Settings → Devices in Orbital on your Mac and scan the code it shows.

WHAT YOU CAN DO

• See every session of your Macs in one list: working, waiting for your input or done, filtered by tag and by device.
• Open a session and read its whole transcript: messages, tool calls, subagents and background tasks.
• Write to a session, attach a photo from the camera or your gallery, and run slash commands and skills.
• Answer the agent's questions and permission requests, with what it wants to do in front of you.
• Start a new session on the Mac you choose, with the folder, model and permission mode you choose, in its own git worktree if you like.
• Approve the steps of a harness, a multi-step task that stops where it needs your OK.
• Rename, tag, pin, clear or end a session, change its model or permission mode, or take over a session running in a terminal.
• Open the files, images and PDFs a session names, with code in colour and Markdown formatted.
• See how much of your plan's usage limits is used, across your accounts and devices.

CALM BY DESIGN

Notifications are off until you turn them on, and show while the app is open. Nothing blinks and nothing counts up: a session waiting for you is a quiet state, not an alarm.

PRIVATE BY CONSTRUCTION

• No account and nothing to sign up for.
• Everything between the phone and your Mac is end-to-end encrypted. The relay, which you run, passes it along and cannot read it.
• Your fingerprint, your face or your screen lock locks the app.
• No ads, no analytics, no tracking. The app checks Orbital's own server for updates to its code and, unless you turn it off in Settings, reports whether updates installed and when the app crashed, never anything from your sessions.
• Open source under the MIT license.

The app is free. Your sessions run on your Mac under your own Claude subscription, the same way they do in the terminal.

Orbital is an independent project by SlothWorks s.r.o. It is not made by, affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC.
```

Every claim is sourced in `mobile/store/app-store.md` → Where each claim comes
from. The lock line follows the Android app: it asks for the phone's
biometrics with the screen lock as the fallback (`web/src/mobile/platform/deviceLock.ts`, `allowDeviceCredential`).

### Graphics

| asset | spec (Play) | file |
|---|---|---|
| App icon | 512 × 512 PNG, up to 1 MB; Play rounds the corners itself | the iOS App Store icon scaled down: `sips -z 512 512 mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png --out icon-512.png` |
| Feature graphic | 1024 × 500 JPEG or 24-bit PNG, no alpha | from Claude Design ([Feature graphic](#feature-graphic)) |
| Phone screenshots | 2 to 8, JPEG or 24-bit PNG, sides 320 to 3840 px, at most 2:1 | 1188 × 2112, the App Store set's seven screens shot again at 9:16 (`docs/ops/release-to-google-play.md` → Screenshots) |
| Tablet screenshots | optional | none: the app is laid out for a phone |

9:16 and at least 1080 px on the short side is what Play asks of screenshots
for the app to be shown in its recommendations; 2:1 is only the limit for
upload.

### Feature graphic

Visual design lives in Claude Design, so the graphic is made there. The prompt:

> A Google Play feature graphic for Orbital, 1024 × 500 px, exported as a
> JPEG or a PNG without transparency. Orbital is a calm companion app that
> shows the Claude Code sessions running on your Mac as planets: one map, what
> is working, what waits for you, what is done. Use Orbital's own look from
> the canvas: the dark space background, the planet and moon motifs, the cyan
> accent, Manrope for the wordmark. Put the wordmark "Orbital" and one short
> line, "Your coding agents, anywhere", on the left half; on the right, a
> planet with two small moons, or the phone's session list (screenshot 01)
> tilted slightly. Keep everything that matters inside the central 924 × 400
> px: Play crops the edges on some surfaces and may lay a play button over the
> centre when a video is linked (none is). No device frames, no "Get it on
> Google Play" badge, no prices or rankings, no Anthropic or Claude logo, no
> small text: it is shown as small as 350 px wide.

## Store settings

| field | value |
|---|---|
| App or game | App |
| Category | Productivity (Play has no Developer Tools category) |
| Tags | Productivity, Business. Play's list has no developer tag; Remote control and Personal assistant mean TV remotes and phone assistants there |
| Email address | `orbital@slothworks.io` |
| Phone number | empty |
| Website | `https://orbital.slothworks.io/` |
| External marketing | on (the default) |

## App content (Policy → App content)

### Privacy policy

`https://orbital.slothworks.io/privacy/`

### Ads

**No, my app does not contain ads.**

### App access

**All or some functionality in my app is restricted**, with one instruction:

| field | value |
|---|---|
| Name | Pairing with a Mac |
| Username, password | empty: there is no account |
| Any other information | the text below (limit 500) |
| "Sign in details in this declaration provide full access…" | ticked: Play requires it to save, and it confirms nothing more can be given |
| "Allow Google to use these sign-in details for testing" | off: there are none |

<!-- app-access -->
```text
No account and no sign-in. The app works only after pairing with Orbital for Mac (a free open-source desktop app, orbital.slothworks.io) by scanning a QR code; it needs a Mac with the user's own Claude subscription and a relay the user runs, which a reviewer cannot be given. A screen recording on demo data shows pairing and every feature: <VIDEO LINK>. The same phone UI is clickable on demo data at https://orbital.slothworks.io.
```

Replace `<VIDEO LINK>` with the Google Drive link of `orbital-app-review.mp4`
(shared as "Anyone with the link can view") before pasting. Leave "Allow
Android to use the credentials you provide for performance and app
compatibility testing" off: there are none. The App Store's longer review
notes (`mobile/store/app-store.md` → Notes) are the answer to send if Play
rejects the app for access.

### Content rating (IARC questionnaire)

Email for the certificate: `orbital@slothworks.io`. Category: **All Other App
Types** (not a game, not social or communication: the only party the user
talks to is their own agent on their own Mac).

The questionnaire as of November 2026:

| section | question | answer | why |
|---|---|---|---|
| Downloaded App | Ratings-relevant content downloaded as part of the app package? | No | The package holds only the app's interface |
| User Content Sharing | Users interact or exchange content with other users? | No | Everything a user writes goes to their own Mac; there are no other users |
| Online Content | Content not part of the download but accessed from the app (the examples name generated AI content)? | **Yes** | The app shows what the user's own agent writes, from the user's Mac |
| → Violence, Sexuality, Language, Controlled Substance | Can the app contain such material (not counting user-generated content)? | No | There is no catalogue; what the agent writes answers the user's own prompts in the user's own coding sessions |
| Promotion or Sale of Age-Restricted Products | | No | |
| Miscellaneous | Location shared with other users; digital goods; cash rewards, crypto, NFTs; web browser or search engine; news or educational | No to all | The app never reads the location; free, no purchase; links open in the system browser |

The result is expected to be the lowest rating (IARC 3, PEGI 3, Everyone).
That is right for the questionnaire; the audience is set separately below.

### Target audience and content

- **Target age groups**: **18 and over** only (decided, as on the App Store:
  Claude accounts are for adults, and the app shows whatever the agent
  writes).
- **Restrict users that Google has determined to be minors**: off (decided:
  the age is the user's own concern; the declaration is enough).
- With 18 and over alone, Play asks nothing about appeal to children.

### Data safety

The conclusion of `mobile/store/app-store.md` → App Privacy, in Play's terms.
Play counts data sent to a service provider that processes it on the
developer's behalf (Firebase, for SlothWorks) as collected, not shared.

**Data collection and security**

| question | answer |
|---|---|
| Does your app collect or share any of the required user data types? | Yes |
| Is all of the user data collected by your app encrypted in transit? | Yes (Beam and Firebase are HTTPS only) |
| Which methods of account creation does your app support? | My app does not allow users to create an account |
| Can users login to your app with accounts created outside of the app? | No (the Claude account lives on the Mac; pairing is not an account) |
| Do you provide a way for users to request that their data is deleted? | Yes; Delete data URL `https://orbital.slothworks.io/privacy/#your-rights` (Play takes only a URL; the section's "Deleting the phone app's data" gives the steps, what is deleted and what is not) |

The form as submitted is exported in `mobile/store/google-play-data-safety.csv`
(Data safety → Export to CSV); after a change, export it again, and use
Import from CSV to restore it.

**Data types**: tick these and nothing else.

| Play category → type | what it is | collected | shared | processed ephemerally | required or optional | purposes |
|---|---|---|---|---|---|---|
| Device or other IDs | Beam's install id; Firebase's installation id and FCM token | Yes | No | No | Required | App functionality, Analytics |
| App info and performance → Crash logs | the kind of a crash, freeze or low-memory exit with the system's reason code | Yes | No | No | Optional (Settings → Send diagnostics) | Analytics |
| App info and performance → Diagnostics | launch time, memory, phone model, OS and app versions | Yes | No | No | Required (the update check always sends the OS and app versions) | App functionality, Analytics |
| App info and performance → Other app performance data | whether an update downloaded, installed or failed | Yes | No | No | Optional | Analytics |
| App activity → App interactions | foreground and background events | Yes | No | No | Optional | Analytics |

Not collected, with the reason in `mobile/store/app-store.md` → Each of
Apple's data types: location (no location API; Beam and Firebase see an IP
address as any server does), personal info, financial info, health, messages
(they go only to the user's own Mac, end-to-end encrypted), photos and videos
(the same), audio, files and docs, calendar, contacts, web browsing, in-app
search history, installed apps, other user-generated content.

What the store page then shows: "No data shared with third parties"; "This
app may collect these data types: App activity, App info and performance,
Device or other IDs"; "Data is encrypted in transit"; "You can request that
data be deleted".

### The other declarations

| declaration | answer |
|---|---|
| Advertising ID | No. The bundle declares no `com.google.android.gms.permission.AD_ID`; check App bundle explorer → the bundle → Permissions before answering |
| Government apps | No |
| Financial features | My app doesn't provide any financial features |
| Health apps | My app does not have any health features |
| News apps | No |

Play may add declarations (it lists what is missing under Publishing
overview). Answer them from the same facts and add them here.

## Countries and price

Free. Every country or region except **Russia** (decided, as on the App
Store).

## Release notes for the first production release

<!-- release-notes -->
```text
The first public release of Orbital for Android: follow, answer and start the Claude Code sessions on your Mac from your phone.
```

Later releases take theirs from `mobile/CHANGELOG.md`, in the user's words,
as on the App Store; limit 500 characters per language.

## Open points

1. **`SCHEDULE_EXACT_ALARM`.** `@capacitor/local-notifications` declares it
   (seen in a merged release manifest). Play restricts exact alarms to apps
   whose core function needs them; `SCHEDULE_EXACT_ALARM`, unlike
   `USE_EXACT_ALARM`, is not pre-granted from Android 14 and needs no
   declaration today, but if Play flags it, remove it in the app's manifest
   (`tools:node="remove"`), a native change.
2. **Self-updating code.** Play's Device and Network Abuse policy forbids an
   app updating itself outside Play, except for code run in a virtual
   machine or interpreter such as JavaScript in a WebView. The over-the-air
   bundles are that (`docs/ops/ship-the-phone-over-the-air.md`), and they
   must not change what the app is for, as on the App Store.
3. **Firebase at launch** and **IP addresses**: the same as
   `mobile/store/app-store.md` → Open points 8 and 9.
