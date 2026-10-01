---
id: a-settings-test-assumes-the-darwin-arm64-cli
title: The claude_code_version settings test fails anywhere but darwin-arm64
status: backlog
type: fix
domain: server
tags:
  - tests
---
# The claude_code_version settings test fails anywhere but darwin-arm64

`server/test/routes.test.ts` → `claude_code_version` → "buildServer publishes
it through GET /api/settings when resolvable" expects the server to publish
`resolveClaudeCodeVersion()`, which reads the Agent SDK's `manifest.json` and
answers on every platform.

The server only uses that answer when `sdkBundledCliAvailable()` is true, and
that function resolves `@anthropic-ai/claude-agent-sdk-darwin-arm64`
specifically. Elsewhere — found on 2026-10-01 in a Linux `node:22` container
— the server falls back to a `claude` on the `PATH`, finds none, publishes
nothing, and the test sees `undefined` where it expected the manifest's
version.

The product is unaffected: Orbital ships for macOS arm64 only, and CI runs on
`macos-latest` for that reason. The test is what is wrong — it should expect
what the server decides, not what the manifest says.
