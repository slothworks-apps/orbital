/**
 * The CLI could start this login only by handing the browser's redirect back
 * to Orbital to relay — which Orbital does not do — or answered with no URL
 * a browser can open.
 */
export class McpLoginUnsupportedError extends Error {}

/**
 * The URL to send the user to, from the SDK's `mcpAuthenticate` answer
 * (idea mcp-login-from-orbital § Spike). The answer is undeclared in
 * `sdk.d.ts`, so it is read field by field and refused when it is not the
 * shape the spike saw: the CLI catching the callback itself on `localhost`.
 * Only an http(s) URL comes back, since the browser is told to open it.
 */
export function mcpLoginUrl(answer: unknown): string {
  const a = (answer ?? {}) as Record<string, unknown>;
  if (a.callbackExpected === false) {
    throw new McpLoginUnsupportedError('the CLI expects no callback for this login');
  }
  if (a.redirectScheme !== undefined && a.redirectScheme !== 'localhost') {
    throw new McpLoginUnsupportedError(`the login redirects to ${JSON.stringify(a.redirectScheme)}, which Orbital does not relay`);
  }
  if (typeof a.authUrl !== 'string') throw new McpLoginUnsupportedError('the CLI answered no login URL');
  let url: URL;
  try {
    url = new URL(a.authUrl);
  } catch {
    throw new McpLoginUnsupportedError('the CLI answered a login URL that does not parse');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new McpLoginUnsupportedError(`the login URL is ${url.protocol}, not http(s)`);
  }
  return a.authUrl;
}
