# Orbital on the App Store: listing, privacy and review material

What goes into App Store Connect for the iOS app (`io.slothworks.orbital.mobile`).
The steps that use it are in the runbook `docs/ops/release-to-the-app-store.md`.
Everything here is written so Google Play can reuse it: the texts carry no
Apple-only wording except where marked, and the privacy reasoning maps onto
Play's Data safety form.

Character counts were measured on the text between the markers below (Unicode
characters, `node` `[...s].length`). Recount after an edit:

```bash
node -e 'const t=require("fs").readFileSync("mobile/store/app-store.md","utf8");for(const m of t.matchAll(/<!-- (\S+) -->\n```text\n([\s\S]*?)\n```/g))console.log(m[1],[...m[2]].length)'
```

Fields with no marker are short enough to check by eye.

## Product page

### Name — limit 30

<!-- name -->
```text
Orbital by SlothWorks
```

21 characters. `Orbital` alone is taken. The name under the icon is the
app's own `CFBundleDisplayName`, `Orbital`.

### Subtitle — limit 30

<!-- subtitle -->
```text
Your coding agents, anywhere
```

28 characters. No Anthropic trademark (guideline 2.3.7, 5.2.1).

### Promotional text — limit 170

Editable at any time without a new submission.

<!-- promo -->
```text
Follow the coding sessions running on your Mac, answer the ones waiting for you and start new ones, from your iPhone. Requires Orbital for Mac and a relay.
```

155 characters.

### Description — limit 4000

<!-- description -->
```text
Orbital shows the Claude Code sessions running on your Mac on your iPhone: which are working, which are waiting for your input and which are done. Answer the ones that need you and start new ones while you are away from your desk.

The iPhone app is a companion to Orbital for Mac and does nothing on its own. You need:

• Orbital for Mac, a free download from orbital.slothworks.io, on a Mac with Apple silicon, with the Claude Code command-line tool installed and signed in to your own Claude account. A Linux server running Orbital works too.
• A relay that connects the phone to your Mac, which you run yourself on a server of your own. It is open source and ships as a Docker image.

Pairing is one scan: open Settings → Devices in Orbital on your Mac and scan the code it shows.

WHAT YOU CAN DO

• See every session of your Macs in one list: working, waiting for your input or done, filtered by tag and by device.
• Open a session and read its whole transcript: messages, tool calls, subagents and background tasks.
• Write to a session, attach a photo from the camera or your library, and run slash commands and skills.
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
• Face ID or your passcode locks the app.
• No ads, no analytics, no tracking. The app checks Orbital's own server for updates to its code and, unless you turn it off in Settings, reports whether updates installed and when the app crashed, never anything from your sessions.
• Open source under the MIT license.

The app is free. Your sessions run on your Mac under your own Claude subscription, the same way they do in the terminal.

Orbital is an independent project by SlothWorks s.r.o. It is not made by, affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC.
```

2,754 characters. Every feature in it is on the phone
today; see "Where each claim comes from" below.

### Keywords — limit 100

Comma-separated, no spaces. None of them repeats a word of the name
(`orbital`, `by`, `slothworks`) or the subtitle (`your`, `coding`, `agents`,
`anywhere`), since those are indexed already. No `claude`, `anthropic` or
other trademark (2.3.7).

<!-- keywords -->
```text
ai,agent,code,developer,terminal,cli,session,remote,companion,mac,assistant,programming,git,llm,mcp
```

### URLs

| field | value |
|---|---|
| Support URL | `https://orbital.slothworks.io/` **once it shows a contact address** (see Open points); until then `https://github.com/slothworks-apps/orbital/issues` |
| Marketing URL | `https://orbital.slothworks.io/` |
| Privacy Policy URL | `https://orbital.slothworks.io/privacy/` (the form without the slash answers with a redirect) |

The contact address is `orbital@slothworks.io` (`site/src/site.ts` →
`CONTACT_EMAIL`, and the privacy policy).

### Categories

- Primary: **Developer Tools**
- Secondary: **Productivity**

### Copyright

```text
2026 SlothWorks s.r.o.
```

App Store Connect adds the © itself.

### Price and availability

Free, every country or region (but see France under Open points).

### Age rating questionnaire

Apple's questionnaire as of November 2026 (help page "Age ratings values and
definitions"). The phone app shows only what the user's own Claude Code
sessions on their own Mac produce; it has no feed, no other users and no web
view of its own.

| section | item | answer | why |
|---|---|---|---|
| In-app controls | Parental Controls | No | |
| | Age Assurance | No | |
| Capabilities | Unrestricted Web Access | No | Links open in Safari, outside the app (`window.open` in `FeedbackSheet.tsx`, `BranchSheet.tsx`, `files/TextPreview.tsx`) |
| | User-Generated Content | No | Nothing a user writes reaches another user; it goes to the user's own Mac |
| | Social Media | No | |
| | Messaging and Chat | No | The chat is with the user's own agent, not with other people |
| | Advertising | No | |
| | Shared Location (asked from 16 November 2026) | No | The app never reads the location |
| Mature themes | Profanity or Crude Humor; Horror/Fear Themes; Alcohol, Tobacco, or Drug Use | None | |
| Medical or wellness | Medical or Treatment Information; Health or Wellness Topics | None | |
| Sexuality or nudity | all three | None | |
| Violence | all four | None | |
| Chance-based | Gambling; Simulated Gambling; Contests; Loot Boxes | None / No | |
| Age categories | | Not Applicable | Not made for kids |

This yields **4+**. Whether to override it is an open point below: the app
shows whatever the agent writes, and Claude accounts are for adults.

### Accessibility Nutrition Labels (optional)

Voluntary in 2026. Claim only what has been checked on a device. Likely true
today: **Larger Text** (follows the system text size up to one and a half
times) and **Dark Interface** (dark by default,
with dark themes). VoiceOver, Voice Control, Sufficient Contrast, Reduced
Motion and Differentiate Without Color Alone are unverified; leave them
unticked until someone tests them. Captions and Audio Descriptions do not
apply (no video).

## App Privacy

### Conclusion

Answer **"Yes, we collect data"**, with three groups of data types, none linked
to the user and none used for tracking:

| Apple data type | collected by | purpose | linked to user | tracking |
|---|---|---|---|---|
| Identifiers → **Device ID** | Beam (install id), Firebase (installation id, FCM token) | App Functionality | No | No |
| Diagnostics → **Crash Data** | Beam | App Functionality | No | No |
| Diagnostics → **Performance Data** | Beam | App Functionality | No | No |
| Diagnostics → **Other Diagnostic Data** | Beam, Firebase | App Functionality | No | No |
| Usage Data → **Product Interaction** | Beam | App Functionality | No | No |

Everything else is **not collected**. SlothWorks runs no relay for App Store
users: every user runs their own, so nothing the relay holds is the
developer's collection (point 3 below). The App Store label then reads "Data
Not Linked to You: Identifiers, Usage Data, Diagnostics", and no "Data Used
to Track You".

### Apple's definitions that decide it

From Apple's "App privacy details" page:

- **Collect**: "transmitting data off the device in a way that allows you
  and/or your third-party partners to access it for a period longer than what
  is necessary to service the transmitted request in real time." A
  third-party SDK in the app (Firebase) counts as a partner.
- **Linked**: data is linked unless it is de-identified before collection,
  "such as stripping data of any direct identifiers, such as user ID or name",
  and the developer does not link it back or tie it to other datasets.
- **Optional disclosure** needs every criterion, among them that collection
  is infrequent, not part of the primary functionality, and chosen by the user
  each time. Diagnostics are on by default and the update check always runs,
  so nothing here qualifies; it is all declared.
- **App Functionality** includes "ensure server up-time, minimize app
  crashes, improve scalability and performance". That is what the diagnostics
  are for (`site/content/privacy.md` → Diagnostics: "only to deliver updates
  and to see whether they work").

### Where the data goes, from the code

What SlothWorks or its processors still receive, with the relay the user's
own: Beam (SlothWorks itself) and Firebase (Google, as SlothWorks'
processor; the Firebase project `orbital-sw` is SlothWorks', built into the
app). Nothing else.

1. **Beam, the update server SlothWorks runs** (`mobile/beam.json`,
   `https://beam.slothworks.io`). Only a release build turns the updater on
   (`mobile/capacitor.config.ts` → `updater`).
   - *Update check, always*: the updater plugin's `deviceId`, platform, OS
     version, app and native versions, plugin version, key prefix, channel,
     store/emulator flags (`site/content/privacy.md` → The update check). On
     iOS the `deviceId` is a random UUID the plugin generates and keeps in the
     Keychain (`node_modules/@capgo/capacitor-updater/ios/Sources/CapacitorUpdaterPlugin/DeviceIdHelper.swift`),
     not the IDFA or IDFV. → **Device ID**.
   - *Send diagnostics, on by default* (`web/src/mobile/update/diagnostics.ts`,
     `platform.ts` → `applyDiagnostics`): install and update results, launch
     time, foreground/background, the kind of an error, crash, freeze or
     low-memory exit with the system's reason code and memory use, and the
     phone model (`platform.ts` → `sendDeviceInfo`). The patch in
     `mobile/patches/` strips every free-text field from the plugin's reports,
     and `mobile/scripts/plugin-privacy.test.mjs` checks it applied.
     → **Crash Data** (crash, freeze, low-memory exit), **Performance Data**
     (launch time, memory), **Other Diagnostic Data** (update results, model,
     OS version), **Product Interaction** (foreground and background, which
     Apple lists under "app launches").
2. **Firebase Cloud Messaging (Google)**, `@capacitor-firebase/messaging`.
   Google's own disclosure for the FirebaseMessaging SDK: it records the APNs
   token with an app installation id that acts as the FCM token, and sends
   device model, language, time zone, OS version, app id and version. Google
   classes these as device identifiers and device information, not linked
   unless the developer links them. → **Device ID**, **Other Diagnostic
   Data**. No Analytics or Crashlytics is in the app (`mobile/package.json`).
   This happens at every launch of a release build, whatever the relay and
   whether or not notifications are on (Proposed privacy policy changes →
   2): the plugin configures Firebase and calls
   `registerForRemoteNotifications()` when it loads, and FCM's auto-init is
   on.
3. **The relay**, which every App Store user runs themselves from the
   Docker image. It stores each device's public key, the FCM token if
   notifications were allowed, last-seen times, pairs and pairing codes
   (`site/content/privacy.md` → What the relay can see and keep). That server
   is the user's, as their Mac is: neither SlothWorks nor a partner of it can
   access it, so it is **not collected**. Session content through it is
   end-to-end encrypted and not stored either way.
4. **The user's own Mac.** Messages, photos, the phone's model and name go to
   the paired Mac, end-to-end encrypted, and on to Claude Code under the
   user's own account. That is the user's own device, not SlothWorks or a
   partner of it: not collected.
5. **Links the user opens** (GitHub feedback form, a pull request, a link in a
   file) open in Safari; what GitHub receives there is not the app's
   collection.

### Each of Apple's data types

| data type | answer | reason |
|---|---|---|
| Contact Info: Name, Email, Phone, Physical Address, Other | Not collected | No account. The Claude account e-mail shown under Limits comes from the user's own Mac, end-to-end encrypted, and goes nowhere else |
| Health, Fitness | Not collected | |
| Payment Info, Credit Info, Other Financial Info | Not collected | Free, no in-app purchase |
| Precise Location, Coarse Location | Not collected | No location API. Beam and Firebase see an IP address, as any server does; not used to locate (see Open points) |
| Sensitive Info | Not collected | |
| Contacts | Not collected | |
| Emails or Text Messages | Not collected | Messages to a session go only to the user's Mac, encrypted |
| Photos or Videos | Not collected | Photos go only to the user's Mac, encrypted (`web/src/mobile/photo.ts`) |
| Audio Data | Not collected | No microphone use |
| Gameplay Content | Not collected | |
| Customer Support | Not collected | Feedback opens GitHub's form in Safari; nothing is sent from the app |
| Other User Content | Not collected | |
| Browsing History, Search History | Not collected | Searches in the app run against the Mac |
| User ID | Not collected | No account, no user-level id |
| Device ID | **Collected** | Beam install id; Firebase installation id and FCM token |
| Purchase History | Not collected | |
| Product Interaction | **Collected** | Foreground/background events with diagnostics on |
| Advertising Data | Not collected | No ads |
| Other Usage Data | Not collected | |
| Crash Data | **Collected** | Crash, freeze, low-memory exit kinds and reason codes |
| Performance Data | **Collected** | Launch time, memory at exit |
| Other Diagnostic Data | **Collected** | Update results, model, OS version; Firebase's device information |
| Environment Scanning, Hands, Head | Not collected | The camera scans a QR code on device (ML Kit runs locally) |
| Other Data Types | Not collected | |

### Why "not linked"

There is no account, name, e-mail or user id anywhere in the system the
data could be joined with. The ids are random per installation, made by the
app or by Firebase, and SlothWorks does not tie them to anything else. That
matches Apple's first de-identification example (no direct identifiers
collected). The cautious alternative, if the owner prefers it, is to mark
Device ID and the diagnostics as linked; it changes the label's heading to
"Data Linked to You" and nothing else.

### For Google Play later

The same three groups map onto Play's Data safety form: Device or other IDs;
App info and performance (crash logs, diagnostics, other app performance
data); App activity (app interactions). Purpose "App functionality" and
"Analytics" where Play has no narrower one, "not shared", "processed
ephemerally: no", encrypted in transit: yes, deletion request: by e-mail.
Android's install id comes from the same plugin but lives in the app's own
storage and goes with an uninstall (Proposed privacy policy changes → 1).

## Push notifications with your own relay

**Push does not reach the App Store app through a relay the user runs.**
Notifications while the app is open still work; a notification to a closed
or suspended app does not.

Why, from the code:

- The app is built with SlothWorks' Firebase project, `orbital-sw`
  (`GoogleService-Info.plist`, `docs/ops/build-the-ios-app.md` → Push). The FCM token
  it gets is a token of that project.
- The relay sends a push through FCM's HTTP v1 API,
  `https://fcm.googleapis.com/v1/projects/<project_id>/messages:send`,
  authenticated with the service-account JSON in `RELAY_FCM_SERVICE_ACCOUNT`
  (`relay/src/push.ts`, `docs/ops/run-the-relay.md`). FCM accepts a token
  only from the project that issued it.
- So a relay can push to the store app only with a service account of
  `orbital-sw`, which is SlothWorks' private key and gives whoever holds it
  the right to push to every installation of the app. It is not handed out.
  A self-hosted relay without it logs "push not sent (no FCM configured)"
  (`LogPushSender`); with a service account of another Firebase project, FCM
  refuses the send.
- What remains: the relay pushes only to a phone it sees offline; an open,
  connected app posts its own local notification (`mobile/capacitor.config.ts`
  → `FirebaseMessaging`, `web/src/mobile/platform/push.ts`). iOS suspends a
  backgrounded app within seconds, so on an iPhone that means notifications
  while the app is open.

The listing therefore promises notifications only while the app is open,
and the review video does not show a push to a locked phone. If push for
self-hosted relays is wanted later, it needs a design of its own (for
example a push gateway SlothWorks runs, which would bring push tokens back
into App Privacy).

The FCM token still goes to Google at launch and, once notifications are
allowed, to the user's own relay, where it is unused.

## App Review Information

### Sign-in required

**No.** Untick "Sign-in required". The app has no account and no login
(`site/content/privacy.md` → Accounts and analytics). What gates it is
pairing with a Mac by scanning a QR code, which a demo account cannot replace.
The notes below say so.

### Contact

| field | value |
|---|---|
| First and last name | the owner's |
| Phone | the owner's, with country code |
| Email | `orbital@slothworks.io` |

### Notes — limit 4000

<!-- review-notes -->
```text
Orbital is a companion app for Orbital for Mac, a free open-source desktop app (https://orbital.slothworks.io, source at https://github.com/slothworks-apps/orbital) that shows and runs the user's Claude Code coding sessions. The iPhone app shows the sessions running on the user's own Mac, lets them answer a session that waits for input, approve a permission request and start a new session.

WHY THE APP CANNOT BE PAIRED DURING REVIEW
The app has no account and no sign-in, so there is no demo account to give. It works only after it is paired with a computer the user owns, by scanning a QR code that Orbital for Mac shows. That needs three things a reviewer does not have:
1. A Mac running Orbital for Mac, with the Claude Code command-line tool installed.
2. The user's own Claude subscription signed in on that Mac: every session runs on the Mac and is billed to that subscription.
3. A relay server that connects the phone to the Mac, which the user runs on a server of their own from Orbital's open-source Docker image. We do not run one for users.
We cannot pair the app with a Mac of ours for review: a paired phone can start coding sessions that run commands on that Mac under our Claude account.

DEMO VIDEO
A recording on a real iPhone paired with a Mac, showing every feature from installation on: <VIDEO LINK>
The sessions in it are demo data.

WHAT YOU CAN CHECK WITHOUT A MAC
- The first screen explains pairing and says where to get Orbital for Mac: Orbital → Settings → Devices on the Mac shows the code.
- The privacy policy is linked in Settings → About. Settings opens only after pairing, so the video shows it.
- Tapping the scan frame asks for the camera (purpose: scanning the pairing code and taking photos to send to a session) and opens the scanner.
- A code that is not an Orbital pairing code is refused with a message.

PERMISSIONS
- Camera: scanning the pairing code; taking a photo to send to a session.
- Photo library: picking a photo to send to a session. The add-only key is present because the camera plugin refuses to work without it; the app never writes to the library.
- Face ID: unlocking the app (can be turned off in Settings).
- Notifications: asked only when the user turns a notification on.

DATA
Everything between the phone and the Mac is end-to-end encrypted; the relay, which the user runs, cannot read it. The app sends nothing to an AI service itself: messages and photos go only to the user's own Mac, where the user's own Claude Code, signed in to the user's own Claude account, runs the session. No ads, analytics or tracking. Privacy policy: https://orbital.slothworks.io/privacy/

Orbital is published by SlothWorks s.r.o. and is not affiliated with Anthropic.

Contact: orbital@slothworks.io
```

Replace `<VIDEO LINK>` before submitting. Apple takes a link (an unlisted
video, or a file share that needs no sign-in) or the video as an attachment
in the same section.

### Review video: shot list

Recorded once per submission whose screens changed, on a real iPhone, with
the Mac in the same frame where it matters (a second camera, or the iPhone's
screen recording beside a Mac screen recording, cut together). The Mac runs
Orbital on staged demo data, so no real project, path or conversation shows:
separate `ORBITAL_CLAUDE_DIR` and `ORBITAL_DATA_DIR`
(`docs/ideas/store-review-without-a-mac.md`). The relay is one the owner
runs from the Docker image, as a user would. Keep it under five minutes, one take per
segment, no music, captions for each segment.

| # | on screen | shows the reviewer |
|---|---|---|
| 1 | The app installed from TestFlight, first launch: launch screen, then STEP 1 OF 2 "Scan the code on a desktop" | What a reviewer sees, and that nothing works without a Mac |
| 2 | On the Mac: Orbital → Settings → Devices shows the QR code | Where the code comes from |
| 3 | Tap the scan frame: the camera permission prompt with its purpose string; allow; scan | The camera purpose string in use |
| 4 | Confirm step: the short code matches on phone and Mac; accept on the Mac; "Open sessions" | Pairing; no account |
| 5 | Face ID prompt on first open, if the app lock is on | The Face ID purpose string in use |
| 6 | Session list: sessions grouped by state, tag filter, device chip | The main screen |
| 7 | Open a session that NEEDS INPUT: the question card, answer it, Send; the Mac shows the session carry on | Answering from the phone |
| 8 | A permission request: approve it | Permission requests |
| 9 | Write a message with a photo: tap the camera or library button, the photo permission prompt, pick a photo, send | The photo purpose strings in use |
| 10 | A harness step waiting for approval: open the steps, approve | Harness gates |
| 11 | New session: pick the device, folder, model, permission mode; start; it appears on the Mac's map | Starting a session |
| 12 | Open an image and a file a session names | Files and media |
| 13 | Turn on a notification from the one-time tip: the iOS permission prompt | Notifications are opt-in |
| 14 | With the app open on another session, a session on the Mac asks for input: the in-app banner and notification appear; tap it, the session opens | Notifications while the app is open. No push to a locked phone: users with their own relay do not get one ([Push notifications with your own relay](#push-notifications-with-your-own-relay)) |
| 15 | Settings: notification rules, Security (app lock), Send diagnostics switch, About with the privacy policy link | Settings, diagnostics opt-out, the policy in the app |
| 16 | Settings → Devices → leave the group: the phone returns to pairing | How a user removes the phone and its data |

The old list in the idea doc is the source; this one follows the app as it is
at 0.25.0.

## What App Review will likely raise, and the answer

| guideline | the risk | how the listing answers it | needs a change? |
|---|---|---|---|
| **2.1 App Completeness** | The reviewer cannot get past pairing | Sign-in required: No; the notes say why; the video shows every feature on a real device | Possibly: if Apple insists, the demo mode in `store-review-without-a-mac` → Not now. Apple allows a demo mode "with prior approval" |
| **4.2 Minimum Functionality** | A web view around a website | Face ID, camera scanning, local notifications, photo attach, an offline cache and end-to-end encryption; the description lists what it does | No |
| **4.2.3(i) App Independence** ("should work on its own without requiring installation of another app") | It needs Orbital for Mac | The notes call it a companion for software on the user's own computer, the same as remote-desktop or home-server clients; the description says so in its second paragraph | Being handled: the first screen will say where to get Orbital for Mac (Open points 10) |
| **5.1.1(i) Privacy policy in the app** | The policy must be linked "within the app in an easily accessible manner". **The phone app has no such link today** (Settings → About has only Send feedback; `grep -ri privacy web/src/mobile` finds none) | The listing's Privacy Policy URL, and a link in Settings | **Being handled** (Open points 1); it must be in the build that is submitted |
| **5.1.1(v) Account deletion** | Only if the app creates an account | It creates none. The only server-side device record is on the user's own relay, removed by Remove device / Leave group | No |
| **5.1.1 purpose strings** (`mobile/ios/App/App/Info.plist`) | Vague or unused permissions | Camera, photo library and Face ID each name their use. `NSPhotoLibraryAddUsageDescription` says the app adds nothing; it exists because `@capacitor/camera` refuses every call without it (`mobile/scripts/camera-plist.test.mjs`); the notes explain it | No |
| **5.1.2(i) third-party AI** | Personal data sent to an AI service needs disclosure and consent | The app sends nothing to an AI service; the user's own Mac runs the user's own Claude Code; the notes and policy say so | No, unless Apple asks for a consent screen |
| **2.5.2 / DPLA 3.3.1(B) downloaded code** | The app updates its own JavaScript over the air | Interpreted code run by WebKit is allowed if it does not change the app's primary purpose; bundles are signed (`docs/ops/ship-the-phone-over-the-air.md`). Not raised in the notes; if asked, answer with that | No, as long as OTA bundles keep to the reviewed purpose |
| **2.3.10 other platforms** | Android named in metadata | The texts name no other mobile platform. The app's update screen names Google Play only on Android (`web/src/mobile/platform/store.ts`) | No |
| **2.3.7 / 5.2.1 trademarks** | "Claude" in the name, subtitle or keywords | None there; the description uses "Claude Code" only to say what the app works with, and credits the trademark | No |
| **1.5 Developer information** | The support URL must offer an easy way to contact | See Support URL above and Open points | Possibly, on the website |
| **2.4.1 iPad** | An iPhone-only app still runs on an iPad, and review sometimes uses one | `TARGETED_DEVICE_FAMILY = 1`; nothing to declare | Check the app once on an iPad in iPhone mode |

## Open points for the owner

1. **Privacy policy link in the app.** Done in phone app 0.26.0 (native
   0.10.0, build 15): Settings → About, and the pairing screen, which a
   reviewer sees first. Submit that build or a later one.
2. **Support URL.** The site shows no contact address once
   `PHONE_RELEASE` is `public` (the invite mailto goes away;
   `site/src/pages/index.astro`). Put `orbital@slothworks.io` in the footer
   or on a `/support/` page, then use the site as the Support URL.
3. **The website still offers SlothWorks' relay.** `site/src/pages/index.astro`
   says "Testers can ask to use ours instead" and "your own, or ours by
   arrangement", and lists notifications among the phone's features. For App
   Store users neither holds: change the site before the store link goes on
   it.
4. **No push with a self-hosted relay** ([Push notifications with your own
   relay](#push-notifications-with-your-own-relay)). Accepted for the first
   release, or designed for later; either way the site and the privacy
   policy should say it (proposed wording below).
5. **Age rating.** The questionnaire gives 4+. The app shows whatever the
   agent writes, and Claude accounts are for adults. Overriding to a higher
   rating (13+ or 18+) is the cautious choice; 4+ is defensible since the app
   itself makes no content.
6. **Linked or not linked.** The recommendation is "not linked"; the cautious
   alternative is above.
7. **The privacy policy's inaccuracies.** Proposed wording below; the
   maintainer edits `site/content/privacy.md`.
8. **Firebase at launch.** Optional: set `FirebaseMessagingAutoInitEnabled`
   to `NO` in `Info.plist` (and `firebase_messaging_auto_init_enabled` to
   `false` in the Android manifest), so no token is made until a
   notification is turned on. A native change; the plugin's `getToken`
   turns auto-init back on when it asks. Since push cannot reach the store
   app through a self-hosted relay anyway, also weigh leaving Firebase out
   of the store build.
9. **IP addresses.** Beam and Firebase see the request's IP address. If Beam
   stores it beyond serving the request, declare Coarse Location or note it;
   check Beam's logs and retention.
10. **First screen.** Done in 0.26.0: the pairing screen says it needs
    Orbital on a Mac and links the site.
11. **Encryption export, France.** `Info.plist` sets
    `ITSAppUsesNonExemptEncryption` to `false`. The app implements standard
    algorithms itself (X25519, AES-256-GCM through `@noble/*`), not only the
    system's. Apple's help lists "standard encryption algorithms" among apps
    that need an export compliance determination, and France controls secure
    communications apps separately (ANSSI). Confirm the exemption still holds
    for a public release, and whether distribution in France needs a
    declaration.
12. **Privacy manifest.** The app target has no `PrivacyInfo.xcprivacy`.
    `@capgo/capacitor-updater` ships none and asks the app to declare
    `NSPrivacyAccessedAPICategoryUserDefaults` (reason `CA92.1`). Check the
    e-mail App Store Connect sent after the last upload for `ITMS-91053`; if
    it is there, add the manifest (a native change).
13. **The review video.** Record it (shot list above) and fill in the link.

## Proposed privacy policy changes

For the maintainer to apply to `site/content/privacy.md`; nothing here is
applied. Quoted text is the policy as it stands; the replacement follows.

### 1. The install id survives a reinstall on iPhone

Verified in the code. On iOS the updater plugin keeps its id in the
Keychain (`kSecClassGenericPassword`, service `app.capgo.updater`,
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), reads it from there
first, and says in its own comment that it "persists across reinstalls"
(`node_modules/@capgo/capacitor-updater/ios/Sources/CapacitorUpdaterPlugin/DeviceIdHelper.swift`).
iOS does not delete an app's Keychain items when the app is deleted. On
Android the id is in the app's own preferences, encrypted with a Keystore
key (`android/.../DeviceIdHelper.java`), which an uninstall removes, and the
app opts out of backup.

In "Updates for the phone app" → The update check, replace:

> - a random install id that the app makes up for itself and that identifies
>   nothing but this installation;

with:

> - a random install id that the app makes up for itself. It is not tied to
>   you, your Apple or Google account or any other app. On Android it is
>   deleted when you uninstall the app. On an iPhone it is kept in the
>   phone's keychain, which iOS does not clear when an app is deleted, so a
>   reinstall on the same iPhone reuses it; it is never copied to iCloud or
>   to another device;

### 2. Firebase gets a token at every launch, not only after notifications are allowed

Verified in the code and in Firebase's documentation:

- `@capacitor-firebase/messaging` configures Firebase and calls
  `UIApplication.shared.registerForRemoteNotifications()` when the plugin
  loads, at app start
  (`node_modules/@capacitor-firebase/messaging/ios/Plugin/FirebaseMessaging.swift`,
  `init`; `FirebaseMessagingPlugin.swift` → `load()`). iOS issues the APNs
  token without asking the user; only showing notifications needs
  permission.
- The app sets no `FirebaseMessagingAutoInitEnabled` (`Info.plist`) or
  `firebase_messaging_auto_init_enabled` (`AndroidManifest.xml`), so FCM's
  default holds. Firebase's iOS client guide: "By default, the FCM SDK
  generates a registration token for the client app instance on app
  launch", and "When a FCM registration is generated, the library uploads
  the identifier and configuration data to Firebase." Google's App Store
  disclosure for the SDK: it "records the APNs token and associates it with
  a collected app installation ID", and "collects device model, language,
  time zone, OS version, application identifier and application version".
- What the app's own code holds back is only the hand-over to the relay:
  `registerPush()` sends the token to the relay only when the permission is
  granted (`web/src/mobile/platform/push.ts`).

Only a release build carries `GoogleService-Info.plist` /
`google-services.json`; a build without them starts no Firebase at all.
Confirm once on a device (a proxy, or Firebase's debug log) before the
policy changes.

In "Notifications", replace:

> The phone asks for permission to show notifications once it is paired. If you
> decline, the app works without them and no push token is sent to the relay.
> The phone app includes Firebase only for push messages: no Firebase
> Analytics, no Crashlytics.

with:

> The phone asks for permission to show notifications only when you turn a
> notification on. If you decline, the app works without them and no push
> token is sent to the relay.
>
> The phone app includes Firebase only for push messages: no Firebase
> Analytics, no Crashlytics. Firebase starts with the app, whether or not
> notifications are on: each time the app opens, it registers this
> installation with Google's Firebase Cloud Messaging, which gives it a push
> token and records an installation id, the phone's model, language, time
> zone, system version and the app's version. Google handles this under its
> own privacy terms. Nothing from your sessions is part of it.

(The first sentence also fixes "once it is paired": the code asks only when a
notification is turned on, `push.ts` → `registerPush` and the changelog's
"never at launch or while pairing".)

### 3. Push and your own relay (decision: SlothWorks runs no relay for users)

The policy never names a SlothWorks relay ("There is no default relay"), so
nothing there has to go. What it says about push no longer holds for a relay
the user runs, since such a relay cannot push to the store app
([Push notifications with your own relay](#push-notifications-with-your-own-relay)).

In "Your devices and the relay", after "whoever runs the relay you use holds
the data described below.", add:

> SlothWorks does not run a relay for users of the phone app; you run your
> own.

In "Your devices and the relay" → Push notifications, replace:

> **Push notifications** go through Google's Firebase Cloud Messaging (and,
> on an iPhone, Apple's push service).

with:

> **Push notifications** go through Google's Firebase Cloud Messaging (and,
> on an iPhone, Apple's push service), and only from a relay that holds the
> Firebase credentials of the Orbital phone app. A relay you run yourself
> does not, so with it the phone shows notifications only while the app is
> open, and sends no push through Google or Apple.

In "Notifications" → On the phone, replace the second bullet's first
sentence:

> **While the app is closed**, the relay sends a push notification through
> Google's Firebase Cloud Messaging; on iPhone, Google passes it on through
> Apple's push service.

with:

> **While the app is closed**, a relay that holds the phone app's Firebase
> credentials sends a push notification through Google's Firebase Cloud
> Messaging; on iPhone, Google passes it on through Apple's push service. A
> relay you run yourself cannot, so with it there are no notifications while
> the app is closed.

"Who is responsible" says "The relay's data is held by whoever runs it",
which stays true.

## Where each claim comes from

| claim in the description | source |
|---|---|
| Session list by state, tags, devices | `web/src/mobile/screens/SessionListScreen.tsx`; `mobile/CHANGELOG.md` |
| Transcript, subagents, background tasks | `screens/SessionScreen.tsx`, `SubagentScreen.tsx`, `TaskScreen.tsx` |
| Photos, slash commands and skills | `screens/SessionComposer.tsx`, `ComposerButtons.tsx`, `photo.ts` |
| Questions and permission requests | `POST /api/sessions/:id/decision/:decisionId` in `server/src/remote/allowlist.ts` |
| New session: device, folder, model, mode, worktree | `screens/NewSessionScreen.tsx`, `NewSessionWorktree.tsx`; the `spawn` group of the allowlist |
| Harness steps | `web/src/mobile/harness/`; the harness routes of the allowlist |
| Rename, tag, pin, clear, end, model, mode, take over | `web/src/mobile/menu/`, `session/ModelSwitch.tsx`, `session/ModeSwitch.tsx`; `/take-over` in the allowlist |
| Files, images, PDFs, code in colour, Markdown | `web/src/mobile/files/` |
| Usage limits | `screens/LimitsScreen.tsx`, `/api/limits` |
| Notifications off until turned on; fixed push text | `web/src/mobile/platform/push.ts`; `site/content/privacy.md` → Notifications |
| Face ID or passcode lock | `web/src/mobile/lockFlow.ts`, `platform/appLock.ts` |
| Diagnostics switch | `web/src/mobile/update/DiagnosticsSetting.tsx` |
