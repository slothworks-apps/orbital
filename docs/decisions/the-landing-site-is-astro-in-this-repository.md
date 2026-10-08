---
id: the-landing-site-is-astro-in-this-repository
title: The landing site is an Astro workspace in this repository
type: adr
status: in-force
domain: site
related:
  - 2026-10-08-landing-site-design
tags:
  - site
  - seo
---

# The landing site is an Astro workspace in this repository

## The problem

Orbital needs a public website at `orbital.slothworks.io`: static, good for
search engines, and showing the app working rather than in screenshots. Two
questions had to be settled first: where its code lives, and what builds it.

## Where it lives

**A separate repository** (as `slothworks-io` is) keeps the website's
dependencies and deploys apart from the app. But the site's demos render the
app's real components, from `web/src`, on demo data. From another repository
that means publishing those components as a package, or copying them, and
every change to the app's look would have to be carried across by hand.

**This repository, as the `site/` workspace.** The demos import from `web/src`
directly, a change to a component reaches the website in the same pull
request, and CI builds the site whenever a change touches what it imports.
The repository is public, which costs nothing here: the site holds nothing
secret. The price is one more workspace in the lockfile and in `CLAUDE.md`'s
rules.

Chosen: this repository.

## What builds it

**Next.js with `output: 'export'`.** React throughout, which is what the app
uses. But a static export gives up what Next is chosen for (image
optimisation, ISR, server actions), still ships the React runtime to every
page, and builds with webpack or Turbopack, so importing `web/src`, which is
built by Vite, means reproducing its build setup.

**Astro with `@astrojs/react`.** Pages render to plain HTML with no
JavaScript, and React runs only where it is used, in the demos. It builds with
Vite, so the demo pages can extend `web/`'s Vite config and the components
behave as they do in the app. Sitemap and per-page metadata are built in or
one official integration away.

Chosen: Astro. Components stay React; only the page shell is Astro.

## Consequences

- `site/` is a seventh workspace. It has no version and no changelog; it is
  deployed from `main`.
- A change in `web/src` can change the website. CI builds the site for such
  changes, and `site/CLAUDE.md` says so.
- Hosting is Cloudflare Workers static assets, as for `slothworks-io`.
