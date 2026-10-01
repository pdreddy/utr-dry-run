import fs from 'node:fs';
import path from 'node:path';
import type { Page, Request, Response } from 'playwright';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const isApiCall = (request: Request) => ['xhr', 'fetch'].includes(request.resourceType());

export interface MutationResult { status: number; url: string; id?: string }

/** Pulls a match identifier out of common JSON response shapes. */
export function extractId(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ['matchId', 'id', 'resultId']) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  for (const key of ['match', 'result', 'data']) {
    const nested = extractId(record[key]);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Clicks `action` and waits for the server to acknowledge the resulting write.
 * A 2xx/3xx API response is the success signal; UI text is verified separately.
 */
export async function clickAndAwaitMutation(page: Page, action: () => Promise<void>, timeout = 20_000): Promise<MutationResult> {
  const response = page.waitForResponse(r => MUTATING.has(r.request().method()) && isApiCall(r.request()), { timeout });
  await action();
  const settled: Response = await response;
  if (settled.status() >= 400) throw new Error(`UTR rejected the change (HTTP ${settled.status()})`);
  const body = await settled.json().catch(() => undefined);
  return { status: settled.status(), url: settled.url(), id: extractId(body) };
}

/** Replaces every value with its type so the capture shows payload shape, never data. */
export function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0])] : [];
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shapeOf(v)]));
  return value === null ? 'null' : typeof value;
}

/** Collapses numeric/uuid path segments so endpoints group together. */
export function endpointTemplate(url: string): string {
  const parsed = new URL(url);
  const pathname = parsed.pathname
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/{uuid}')
    .replace(/\/\d+(?=\/|$)/g, '/{id}');
  return `${parsed.origin}${pathname}`;
}

function parseBody(text: string | null): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return 'non-json'; }
}

/**
 * Records the API calls the UTR web app makes while the account owner performs
 * one create-match and one score entry by hand. Only method, endpoint template,
 * status and payload *shape* are stored: no headers, cookies, tokens or values.
 */
export function recordApiCalls(page: Page, dir = process.env.UTR_LOG_DIR || 'logs'): () => string {
  const calls: { method: string; endpoint: string; status?: number; request?: unknown; response?: unknown }[] = [];
  const listener = async (response: Response) => {
    const request = response.request();
    if (!isApiCall(request)) return;
    const mutating = MUTATING.has(request.method());
    if (!mutating && !/\/api\/|api\./i.test(response.url())) return;
    calls.push({
      method: request.method(), endpoint: endpointTemplate(response.url()), status: response.status(),
      request: mutating ? shapeOf(parseBody(request.postData())) : undefined,
      response: mutating ? shapeOf(await response.json().catch(() => undefined)) : undefined
    });
  };
  page.context().on('response', listener);
  return () => {
    page.context().off('response', listener);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'utr-api-capture.json');
    fs.writeFileSync(file, JSON.stringify(calls, null, 2));
    return file;
  };
}
