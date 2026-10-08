---
id: deploy-the-site
title: Deploy the Orbital website
type: runbook
status: in-force
domain: site
related:
  - the-landing-site-is-astro-in-this-repository
  - 2026-10-08-landing-site-design
tags:
  - site
  - deploy
---
# Deploy the Orbital website

## What it is

`site/` is the Astro workspace that builds `orbital.slothworks.io`,
static, with React used only inside the demos. It is deployed to
Cloudflare Workers static assets by
`.github/workflows/site-deploy.yml`, never built or served by hand in
production.

## One-time Cloudflare setup

Done once, by the maintainer, outside this repository:

1. **An API token** (My Profile → API Tokens → Create Token) scoped to
   the account that holds the `slothworks.io` zone, with the
   **Workers Scripts: Edit** and **Workers Routes: Edit** permissions
   (the second is what lets the token attach the custom domain). Account
   scope, not user scope.
2. **The account ID**, shown on the Cloudflare dashboard's Workers &
   Pages overview page for that account.
3. **Two repository secrets**, under this repository's Settings →
   Secrets and variables → Actions:
   - `CLOUDFLARE_API_TOKEN` — the token from step 1.
   - `CLOUDFLARE_ACCOUNT_ID` — the account ID from step 2.
4. **The custom domain.** `orbital.slothworks.io` must be a hostname
   under a zone (`slothworks.io`) already active on that Cloudflare
   account. `site/wrangler.jsonc` already names the route
   (`routes: [{ pattern: "orbital.slothworks.io", custom_domain: true }]`);
   the first `wrangler deploy` with a valid token creates the DNS record
   and certificate for it. No DNS or dashboard step is needed beyond the
   zone existing.

## Normal deploy

Merge a pull request that touches `site/**`, `web/src/**` or
`shared/**` into `main`. `site-deploy.yml` builds the site
(`npm run build -w @orbital/site`) and runs `npx wrangler deploy` from
`site/`. Nothing else triggers it — the site has no version to bump and
no changelog to update first.

## Manual deploy

Two ways, both skip CI's build step so make sure `site/dist` is fresh
first:

- **Re-run the workflow.** Actions → "Site deploy" → Run workflow. Runs
  the same build-then-deploy steps as a push to `main`, against whatever
  is on `main` at the time.
- **From a checkout**, for a deploy without going through `main` at all
  (a hotfix, a test of the Cloudflare setup itself):

  ```bash
  npm run build -w @orbital/site
  cd site && npx wrangler deploy
  ```

  This needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the
  shell's environment, and a build that is actually current — wrangler
  deploys whatever is in `site/dist`, built or not.

## Rollback

```bash
cd site
npx wrangler deployments list   # find the deployment id to go back to
npx wrangler rollback <deployment-id>
```

Run with no arguments, `wrangler rollback` rolls back to the deployment
before the current one. A rollback only swaps which built version of
`site/dist` is live; it does not touch `main` or revert a commit, so
the next push to `main` deploys forward again unless the breaking
change is reverted first.

## Regenerating the demo images

The posters and narrow-screen images under `site/public/demo/` are
screenshots of the demos, taken by a script that drives the built demos
in a headless browser — the screenshot script, see `site/CLAUDE.md`. It
lives in `site/scripts/` once added, and is run by hand, not by the
build: it is only re-run when the app's look changes.
