---
id: a-paid-slothworks-relay-with-push
title: A paid SlothWorks relay (or push gateway) that delivers push
status: backlog
type: idea
domain: remote
related:
  - release-to-the-app-store
  - store-review-without-a-mac
  - run-the-relay
  - encrypted-push-payloads
tags:
  - relay
  - push
  - mobile
---
# A paid SlothWorks relay (or push gateway) that delivers push

## The gap

The store builds of the phone app are built with SlothWorks' Firebase
project, so a push token they hand out belongs to that project, and only a
sender holding that project's service-account key can push to it. That key
can push to every installation of the app, so it cannot be handed to
people who run their own relay. A self-hosted relay without it logs "push
not sent"; its phones get only the notifications the open, connected app
shows itself, which on an iPhone means only while the app is open.

The first public release ships that way: free, self-hosted relay, no push,
and the listing says so plainly.

## The idea

Offer push as a paid SlothWorks service, which is also a way to fund
Orbital's development.

- **A push gateway only.** People keep their own relay; it hands the
  gateway a token and an empty wake-up, never session content
  ([[encrypted-push-payloads]]). The smallest service to run, and nothing
  of a session passes through SlothWorks.
- **A hosted relay.** For people who do not want to run Docker somewhere
  their phone can reach, which is most people who find the app in a store.
  It could have a free tier without push and a paid tier with it.

Self-hosting stays free and complete apart from push, which is missing for
a technical reason, not held back.

## Open questions

- **App Store guideline 3.1.1.** Push unlocked by a subscription bought
  outside the app may count as a digital service Apple wants sold through
  in-app purchase. The likely-safe shape: sold on the website and managed
  on the Mac; the phone app names no price and offers no purchase, it only
  finds that push works. Check before building anything.
- **Billing, VAT and terms.** A merchant of record (Paddle, Lemon Squeezy)
  instead of handling VAT by hand; terms of service; what uptime is
  promised.
- **App Privacy and the privacy policy.** A gateway brings push tokens back
  into what SlothWorks collects; both change with it.
- **Gateway or hosted relay first**, and whether the hosted relay's free
  tier exists at all.
