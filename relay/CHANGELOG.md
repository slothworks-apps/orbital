# Changelog — Orbital relay

All notable changes to the relay image. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow `version` in `relay/package.json`.

## [Unreleased]
### Fixed
- A phone removed from a Mac at the very moment it reconnects is now told it is unpaired, and can no longer reach that Mac through the connection it opened.

## [0.3.0] — 2026-10-07
### Added
- The relay tells the Mac and the phone which version it runs, so they can say when it needs an update instead of going quiet.

## [0.2.0] — 2026-10-04
### Added
- An optional shared secret (`RELAY_SECRET`): when it is set, the relay accepts only devices and pairing requests that present it, and a device with a missing or wrong secret is told so and stops reconnecting.
- A phone that connects expecting to be paired is told when its pair no longer exists, so it notices a Mac that removed it while it was away.
- The pairing redeem endpoint answers CORS requests, so the Android app can pair from its WebView.
### Changed
- The image runs on Node 24 LTS.
### Fixed
- The Docker image builds without a compiler toolchain.

## [0.1.0] — 2026-10-01
### Added
- First release of the Orbital relay: a blind relay between a Mac running Orbital and its paired phones. It routes end-to-end encrypted frames between the devices of a pair and never sees what they carry.
- Devices sign in with their own keys, and frames are routed only between devices that are paired with each other.
- Signed pairing endpoints for the whole flow: the Mac asks for a pairing code, the phone redeems it with a proof from the QR code that the relay never sees, the Mac confirms, and either side can revoke the pair.
- Presence: each device learns when its paired devices come online or go away.
- A phone that is offline is woken with a push notification through Firebase Cloud Messaging; without Firebase credentials, wakes are only logged.
- Pairing requests are rate-limited per client address, with `RELAY_TRUST_PROXY` for running behind a reverse proxy.
- Storage in SQLite by default, or in Postgres through `RELAY_DATABASE_URL`.
- Logs carry metadata only, never message content.
- Shipped as a Docker image.
