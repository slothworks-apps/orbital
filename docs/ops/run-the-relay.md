---
id: run-the-relay
title: Run the mobile remote relay
type: runbook
status: in-force
domain: remote
related:
  - 2026-10-08-builds-for-testers-design
  - 2026-09-30-mobile-remote-design
  - 2026-10-01-mobile-remote-backend
  - the-relay-store-is-kysely-over-sqlite-and-postgres
  - 2026-10-02-mobile-app-read
  - the-relay-answers-cors-for-redeem
tags:
  - relay
  - deploy
---
# Run the mobile remote relay

## What it is

`relay/` is the blind relay a phone and a Mac meet through. It stores
devices (public key, kind, push token, last seen), pairs (which phone may
talk to which Mac) and pairing tokens. It keeps no device names: the
phone's name reaches the Mac sealed, and a push reads only "Orbital"
(spec 2026-10-08-relay-knows-no-names-design). It never
sees a session, a transcript, a path or a frame's body — every frame it
routes is end-to-end encrypted, and it forwards bytes without opening
them. The one exception is a `wake` token: an opaque per-session hash the
relay can count ("2 sessions need your input") but not name.

## Deploy on Dokploy

1. **A Postgres service first**, from Dokploy's own template. Note its
   internal connection string.
2. **The application**, type Docker:
   - repository root as the build context
   - Dockerfile path `relay/Dockerfile`
   - port `4840`
   - env:
     - `RELAY_DATABASE_URL` — the Postgres service's internal URL.
       Required for a real deployment; without it the relay falls back to
       a SQLite file, which is for tests and a laptop only.
     - `RELAY_PORT` — defaults to `4840`; only set it if you also change
       the exposed port.
     - `RELAY_FCM_SERVICE_ACCOUNT` — path to a mounted Firebase
       service-account JSON (mount it as a Dokploy secret file and point
       this at the mounted path). Absent means pushes are only logged,
       never sent.
     - `RELAY_SECRET` — **set it on any relay reachable from the
       internet.** A shared password that every Mac and phone must present
       to connect or pair. Make it long and random — `openssl rand -base64 24`
       — rather than a short code: a refused guess on the WebSocket is not
       rate-limited, so a short secret can be ground down over days. Without
       it anyone who knows the URL can run their own pairs over your relay
       and your Firebase project ([[the-relay-takes-a-shared-secret]]).
       Put the same value into Settings → Mobile → Advanced → Relay secret
       on the Mac; the pairing code carries it to phones. Absent means an
       open relay — fine on a laptop, not on a server.
     - `RELAY_TRUST_PROXY=1` — **set it on Dokploy.** Traefik terminates
       the connection, so without it every request seems to come from
       Traefik's address and one shared pairing rate limit throttles all
       clients together. With it, the relay reads the client's IP from
       `X-Forwarded-For`. Leave it unset when the relay is reachable
       directly: a client could then name any IP it likes in that header.
   - a domain with TLS from the Dokploy proxy
   - health check `GET /health`, answering `{"app":"orbital-relay"}`

Instead of building from the repository, the application can pull the
image GitHub Actions publishes. `.github/workflows/release.yml` builds it
only when `version` in `relay/package.json` has gone up and that version is
not yet in GHCR ([[2026-10-08-builds-for-testers-design]]); a change merged
without a bump never reaches the image:

- `ghcr.io/slothworks-apps/orbital-relay:<version>` — `version` from
  `relay/package.json`; written once, never moved
- `ghcr.io/slothworks-apps/orbital-relay:latest` — the newest version
- `ghcr.io/slothworks-apps/orbital-relay:sha-<commit>` — the commit the
  version was built from

The workflow runs the relay's typecheck and tests on Linux first and does
not deploy anything; redeploy by hand. If the run failed before the push,
nothing was published; run it again with Actions → Release → Run workflow.
The package is public, so anyone can pull it without a registry login.
The image is built for `linux/amd64` only.

The build context is the repository root, so the ignore file is
`relay/Dockerfile.dockerignore` (BuildKit reads it next to the Dockerfile);
a `relay/.dockerignore` would never apply and the Mac's `node_modules` would
land in the image. `npm ci` runs with `--ignore-scripts`: better-sqlite3
ships prebuilt binaries, and its install script would only try to compile
it with a toolchain the image does not have.

To try the image before deploying it, from the repository root:

```bash
docker build -f relay/Dockerfile -t orbital-relay:test .
docker network create orb-relay-test
docker run -d --rm --name orb-pg --network orb-relay-test -e POSTGRES_PASSWORD=pw postgres:17
docker run -d --rm --name orb-relay --network orb-relay-test -p 14840:4840 \
  -e RELAY_DATABASE_URL=postgres://postgres:pw@orb-pg:5432/postgres \
  -e RELAY_SECRET=x -e RELAY_TRUST_PROXY=1 \
  -e RELAY_FCM_SERVICE_ACCOUNT=/run/secrets/fcm.json \
  -v "$PWD/secrets/orbital-relay-fcm.json:/run/secrets/fcm.json:ro" orbital-relay:test
curl -s localhost:14840/health
docker rm -f orb-relay orb-pg && docker network rm orb-relay-test
```

The schema is created on boot (`relay/migrations/`, run by a static,
bundled migration provider). There is nothing to run by hand and no
separate migrate step.

A relay deployed before 2026-10-02 must be redeployed before a phone can
pair with it or be told `unpaired`: it needs the CORS answer on
`/pair/redeem` ([[the-relay-answers-cors-for-redeem]]) and the `paired=1`
handling on connect, both added by [[2026-10-02-mobile-app-read]].

## More than one instance

Not needed today, and not built. What is built is the hook for it: every
device connects to `/ws?mac=<id>` — the Mac's own id, or on a phone the
id from the QR it scanned. A load balancer that hashes on that query
parameter keeps both halves of a pair on one instance. Since 2026-10-02 the
same query may carry `paired=1`, which the relay does read: a device that
expects a pair the relay no longer holds is told `unpaired` on connect.

Dokploy's Traefik cannot hash on a query parameter. Put nginx in front
instead, with `hash $arg_mac consistent;` in the `upstream` block.

Pairing's HTTP calls (`/pair/token`, `/pair/redeem`, `/pair/confirm`,
`/pair/revoke`) may land on any instance today, since they go through
Postgres and reach the Mac over its own open connection — a
`pair_request` control message is sent only by the instance that is
holding the Mac's socket. If sticky routing is ever switched on, the
redeem endpoint needs the same `?mac=` routing: the phone has the Mac's
id from the QR and can append it to the redeem URL. That is a one-line
change, not built, because there is nothing to route to yet.

## Point Orbital at it

Settings → Mobile → Advanced → Relay URL on the Mac (the `remote_relay_url`
setting), and Relay secret next to it (`remote_relay_secret`, the relay's
`RELAY_SECRET`). The pairing QR carries both to the phone, so they are set
once, on the Mac. There is no default relay: until this is set, the
remote does not start and the status line reads "couldn't start".

## Run it locally

```bash
npm run dev -w relay
```

Then set `remote_relay_url` to `http://127.0.0.1:4840`. With no
`RELAY_DATABASE_URL`, this opens (and creates, on first run) a SQLite file
under `relay/data/`.

## Rotate or wipe

**Change the secret:** set the new `RELAY_SECRET` on the relay and redeploy,
then enter it under Settings → Mobile → Advanced on each Mac. Every phone
is refused as soon as the relay restarts and lands on its unpaired screen;
saving the new secret on the Mac forgets its paired phones locally (its
own link was refused, so the relay keeps their dead pair rows — harmless);
each phone pairs again by scanning a fresh code, which carries the new
secret. A phone built before 2026-10-03 does not know the refusal and shows
the Mac as offline instead; update it.

Deleting the relay's database unpairs every phone from every Mac: locally
that is `relay/data/relay.db`; on Dokploy, whatever file or Postgres
database `RELAY_DATABASE_URL` points at. There is nothing else to lose —
the relay holds no transcripts, no messages, nothing a phone or a Mac
would miss beyond having to pair again.

## Logs

Every line the relay writes starts with `relay:`. Ids and push tokens
are cut to a prefix of `LOG_ID_PREFIX_CHARS` (`relay/src/log.ts`).
Logged, exactly:

- `device <id> connected` (with `, replacing its previous socket` when
  the device already had one) and `device <id> disconnected`
- `pairing token minted for mac <id>`
- `pairing token redeemed: mac <id>, phone <id>`
- `pairing rejected: mac <id> offline for phone <id>` (a redeem while the
  Mac was offline) and `pairing rejected: mac <id>, phone <id>` (the user
  said no on the Mac)
- `pairing confirmed: mac <id>, phone <id>`
- `pair revoked: mac <id>, phone <id>`
- `push sent to <token>, count <n>` and `push failed to <token>, count
  <n>: <error>`; without FCM configured, also `push not sent (no FCM
  configured) to <token>, count <n>`
- warnings from a failing store write or wake hook (`relay: <what>:
  <error message>`)

Never logged: a frame's body, a full id or token. Device names the relay
never has. The relay cannot log what it never decrypts.
