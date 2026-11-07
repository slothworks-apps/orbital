import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SessionTools } from '../runner/runner.js';
import type { BrowserBridge, CaptureResult } from './bridge.js';
import { fitScreenshot } from './image.js';

/**
 * The agent's `browser_screenshot` (spec 2026-11-05-browser-bridge-design
 * § `browser_screenshot`, the agent's tool). Not among the tools that skip the
 * permission card: it goes through `canUseTool` like any other Orbital tool,
 * so the session's permission mode decides whether the user is asked.
 */
export const BROWSER_SCREENSHOT_TOOL = 'browser_screenshot';

/**
 * The image the model gets: the API scales anything larger down to about
 * this edge anyway, so sending more only costs the transfer.
 */
const TOOL_IMAGE_MAX_EDGE = 1568;

/** The API's ceiling on one image, which it applies to the base64 the image travels as. */
const TOOL_IMAGE_MAX_BASE64 = 5 * 1024 * 1024;

/** The image's own bytes that stay under `TOOL_IMAGE_MAX_BASE64` once encoded: base64 spends 4 characters on every 3 bytes. */
export const TOOL_IMAGE_MAX_BYTES = Math.floor(TOOL_IMAGE_MAX_BASE64 / 4) * 3;

const DESCRIPTION = [
  'Take a screenshot of the active tab in the user\'s web browser (the Chromium browser with Orbital\'s browser extension, used last), and see it as an image together with its URL and title.',
  'Use it when the user refers to what they have open in their browser and you need to see it.',
].join(' ');

const FAILURE_TEXT: Record<Exclude<CaptureResult, { ok: true }>['reason'], string> = {
  // Word for word what the transcript shows (canvas 64d.5): it names where to fix it.
  'no-extension': 'No browser is connected to Orbital. The user can open the Orbital extension in their browser, or pair one in Settings → Labs → Browser bridge.',
  disabled: 'The browser bridge is turned off in Orbital\'s Settings.',
  timeout: 'The browser did not answer in time.',
  failed: 'The browser could not take the screenshot',
};

/** A browser's reason as a sentence of the result: it ends in a full stop before the next one starts. */
function sentence(detail: string): string {
  const trimmed = detail.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * A result in words. Never an error: a screenshot that could not be taken
 * leaves nothing to retry, and the agent says so (spec § `browser_screenshot`);
 * the transcript does not count it as a failed call.
 */
function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

export function browserScreenshotTool(bridge: Pick<BrowserBridge, 'capture'>) {
  return tool(BROWSER_SCREENSHOT_TOOL, DESCRIPTION, {}, async () => {
    const result = await bridge.capture();
    if (!result.ok) {
      const why = FAILURE_TEXT[result.reason];
      if (result.reason !== 'failed') return text(why);
      // A chrome:// page or the Web Store is the usual reason the browser gives.
      return text(`${why}${result.detail ? `: ${sentence(result.detail)}` : '.'} Pages such as chrome:// and the extension store cannot be captured.`);
    }
    const shot = await fitScreenshot(result.shot, { maxBytes: TOOL_IMAGE_MAX_BYTES, maxEdge: TOOL_IMAGE_MAX_EDGE });
    if (!shot) return text('The screenshot could not be made small enough to send.');
    return {
      content: [
        { type: 'image' as const, data: shot.bytes.toString('base64'), mimeType: shot.mediaType },
        { type: 'text' as const, text: `The active tab: ${result.title || '(untitled)'} — ${result.url || '(no URL)'}` },
      ],
    };
  }, { alwaysLoad: true });
}

/** The tool for a session's `orbital` server, while the switch is on. */
export function browserSessionTools(bridge: BrowserBridge): SessionTools | undefined {
  if (!bridge.enabled()) return undefined;
  return { tools: [browserScreenshotTool(bridge)], allowedTools: [] };
}
