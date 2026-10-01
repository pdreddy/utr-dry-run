import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Locator, Page } from 'playwright';

export interface UtrSession { context: BrowserContext; page: Page; externallyManaged: boolean; close(): Promise<void> }

export interface BrowserDiagnostics {
  capture(label: string, error: unknown): Promise<{ screenshot?: string; trace?: string; snapshot: string }>;
  finish(): Promise<void>;
}

function safeLabel(value: string): string {
  return value.replace(/[^a-z0-9_.-]/gi, '_');
}

export function redactDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = url.search ? '?[REDACTED]' : '';
    url.hash = '';
    return url.toString();
  } catch { return value.split('?')[0]!; }
}

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/\bauthorization\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, 'Authorization=[REDACTED]')
    .replace(/\b(cookie|password|token|secret)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
}

/**
 * Collects browser evidence without recording response bodies, headers, cookies,
 * or form values. A trace chunk is rotated after each captured failure so bulk
 * processing can continue while preserving evidence for every failed match.
 */
export async function startBrowserDiagnostics(context: BrowserContext, page: Page): Promise<BrowserDiagnostics> {
  const screenshotDir = process.env.UTR_SCREENSHOT_DIR || 'screenshots';
  const traceDir = process.env.UTR_TRACE_DIR || 'traces';
  const artifactDir = process.env.UTR_ARTIFACT_DIR || 'artifacts';
  for (const dir of [screenshotDir, traceDir, artifactDir]) fs.mkdirSync(dir, { recursive: true });
  let consoleErrors: string[] = [];
  let pageErrors: string[] = [];
  let networkFailures: Array<{ method: string; url: string; error: string }> = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(redactDiagnosticText(message.text())); });
  page.on('pageerror', error => pageErrors.push(redactDiagnosticText(error.message)));
  page.on('requestfailed', request => networkFailures.push({
    method: request.method(), url: redactDiagnosticUrl(request.url()), error: request.failure()?.errorText || 'request failed'
  }));
  let tracing = false;
  const begin = async () => {
    if (tracing) return;
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    tracing = true;
  };
  await begin();
  return {
    async capture(label, error) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = `${safeLabel(label)}-${stamp}`;
      const screenshotFile = path.join(screenshotDir, `${base}-error.png`);
      const traceFile = path.join(traceDir, `${base}.zip`);
      const snapshotFile = path.join(artifactDir, `${base}.json`);
      const screenshotSaved = await page.screenshot({ path: screenshotFile, fullPage: true }).then(() => true).catch(() => false);
      // Clone only the visible document structure. Scripts, metadata, form values,
      // and URL-bearing attributes are unnecessary for selector repair and can
      // contain account/session data.
      let html = await page.locator('body').evaluate(element => {
        const clone = element.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('script, style, noscript, iframe, object, embed').forEach(node => node.remove());
        clone.querySelectorAll('input, textarea, select').forEach(field => {
          field.removeAttribute('value');
          field.textContent = '';
        });
        clone.querySelectorAll('*').forEach(node => {
          for (const attribute of [...node.attributes]) {
            if (/^(href|src|action|formaction)$/i.test(attribute.name) || /token|secret|password|cookie|auth/i.test(attribute.name)) {
              node.setAttribute(attribute.name, '[REDACTED]');
            }
          }
        });
        return clone.outerHTML;
      }).catch(() => '');
      html = redactDiagnosticText(html);
      const accessibility = await page.locator('body').ariaSnapshot({ timeout: 2_000 }).catch(() => 'unavailable');
      fs.writeFileSync(snapshotFile, JSON.stringify({
        timestamp: new Date().toISOString(), error: redactDiagnosticText(error instanceof Error ? error.message : String(error)),
        url: redactDiagnosticUrl(page.url()), title: await page.title().catch(() => ''), accessibility,
        html, consoleErrors, pageErrors, networkFailures
      }, null, 2));
      let traceSaved = false;
      if (tracing) {
        traceSaved = await context.tracing.stop({ path: traceFile }).then(() => true).catch(() => false);
        tracing = false;
      }
      await begin().catch(() => undefined);
      consoleErrors = [];
      pageErrors = [];
      networkFailures = [];
      return {
        screenshot: screenshotSaved ? screenshotFile : undefined,
        trace: traceSaved ? traceFile : undefined,
        snapshot: snapshotFile
      };
    },
    async finish() {
      if (tracing) { await context.tracing.stop().catch(() => undefined); tracing = false; }
    }
  };
}

export function shouldRunHeadless(value = process.env.UTR_HEADLESS): boolean {
  return value?.trim().toLocaleLowerCase() === 'true';
}

export function validatedCdpUrl(value = process.env.UTR_CDP_URL): string | undefined {
  if (!value?.trim()) return undefined;
  const url = new URL(value);
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !localHosts.has(url.hostname)) {
    throw new Error('UTR_CDP_URL must point to Chrome on localhost');
  }
  return url.toString();
}

export async function openSession(): Promise<UtrSession> {
  const { chromium } = await import('playwright');
  const cdp = validatedCdpUrl();
  if (cdp) {
    const browser = await chromium.connectOverCDP(cdp);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Connected Chrome has no browser context');
    const existing = context.pages().find(candidate => candidate.url().includes('app.utrsports.net'));
    const page = existing ?? await context.newPage();
    // This Chrome process belongs to the user. Never close its default context
    // or pages; ending this Node process drops the CDP transport naturally.
    return { context, page, externallyManaged: true, close: async () => undefined };
  }
  const profile = path.resolve(process.env.UTR_PROFILE_DIR || '.playwright/utr-profile');
  fs.mkdirSync(profile, { recursive: true });
  const channel = process.env.UTR_BROWSER_CHANNEL || undefined;
  const executablePath = process.env.UTR_BROWSER_EXECUTABLE || undefined;
  // Do not infer headless mode from DISPLAY: macOS and Windows normally have no
  // DISPLAY variable, and doing so prevents the user from completing login/MFA.
  const headless = shouldRunHeadless();
  const context = await chromium.launchPersistentContext(profile, {
    headless, channel, executablePath, viewport: { width: 1440, height: 1000 }
  });
  const page = context.pages()[0] ?? await context.newPage();
  return { context, page, externallyManaged: false, close: () => context.close() };
}

export async function screenshot(page: Page, name: string): Promise<string> {
  const dir = process.env.UTR_SCREENSHOT_DIR || 'screenshots';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name.replace(/[^a-z0-9_.-]/gi, '_')}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/** First visible candidate inside `scope` (a page, dialog, or match card). */
export async function firstVisible(scope: Page | Locator, selectors: readonly string[]) {
  for (const selector of selectors) {
    const candidate = scope.locator(selector).first();
    if (await candidate.isVisible().catch(() => false)) return { selector, locator: candidate };
  }
  return undefined;
}
