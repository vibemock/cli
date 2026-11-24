import type { VibeMockClient } from './client.js';

export const LOCAL_CLI_CALLBACK_URL = 'local://cli';

const BLOCKED_FORWARD_HEADERS = new Set([
  'host',
  'cookie',
  'authorization',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'te',
]);

export interface PendingLocalRecord {
  trace_id: string;
  appid: string;
  env: string;
  biz_key: string | null;
  callback_url: string | null;
  callback_status: string;
  callback_payload: string | null;
  callback_headers_json?: string | null;
}

export interface ForwardedCallbackSummary {
  trace_id: string;
  biz_key: string | null;
  target_url: string;
  status: 'sent' | 'failed';
  http_status: number | null;
  duration_ms: number;
  error: string | null;
}

/**
 * Strip hop-by-hop and sensitive headers before forwarding cloud-generated webhook headers locally.
 */
export function sanitizeForwardHeaders(rawJson: string | null | undefined): Record<string, string> {
  const safe: Record<string, string> = { 'content-type': 'application/json' };
  if (!rawJson) return safe;
  try {
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return safe;
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== 'string') continue;
      const lower = k.toLowerCase();
      if (BLOCKED_FORWARD_HEADERS.has(lower) || lower.startsWith('proxy-')) {
        continue;
      }
      safe[k] = v;
    }
  } catch {
    return safe;
  }
  return safe;
}

export interface ForwardOptions {
  appid: string;
  env: string;
  targetUrl: string;
  once: boolean;
  timeoutMs: number;
  intervalMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onForwarded?: (item: ForwardedCallbackSummary) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function forwardLocalCallbacks(
  client: VibeMockClient,
  options: ForwardOptions,
): Promise<ForwardedCallbackSummary[]> {
  // Validate targetUrl locally (only http/https allowed; never trusts cloud URL).
  let parsedTarget: URL;
  try {
    parsedTarget = new URL(options.targetUrl);
  } catch {
    throw new Error(`Invalid local forward target URL "${options.targetUrl}".`);
  }
  if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
    throw new Error(`Forward target URL must use http:// or https://, got "${options.targetUrl}".`);
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + options.timeoutMs;
  const delivered: ForwardedCallbackSummary[] = [];

  while (true) {
    const res = await client.request<{ records: PendingLocalRecord[] }>('/_inspect/records', {
      query: {
        appid: options.appid,
        env: options.env,
        callback_status: 'pending',
        limit: 20,
      },
    });

    const pendingLocal = res.records
      .filter((r) => r.callback_url === LOCAL_CLI_CALLBACK_URL && r.callback_status === 'pending')
      .reverse(); // oldest first

    for (const rec of pendingLocal) {
      const headers = sanitizeForwardHeaders(rec.callback_headers_json);
      const started = now();
      let status: 'sent' | 'failed' = 'failed';
      let httpStatus: number | null = null;
      let responseBody: string | null = null;
      let errorMsg: string | null = null;

      try {
        const localRes = await fetchImpl(parsedTarget.toString(), {
          method: 'POST',
          headers,
          body: rec.callback_payload ?? '',
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
        });
        httpStatus = localRes.status;
        responseBody = await localRes.text();
        if (localRes.status >= 200 && localRes.status < 300) {
          status = 'sent';
        } else {
          errorMsg = `Local receiver returned HTTP ${localRes.status}`;
        }
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
      }

      const durationMs = Math.max(0, now() - started);

      await client.request(
        `/_inspect/records/${encodeURIComponent(rec.trace_id)}/callback-result`,
        {
          method: 'POST',
          body: {
            status,
            http_status: httpStatus,
            response_body: responseBody,
            duration_ms: durationMs,
            error: errorMsg,
          },
        },
      );

      const summary: ForwardedCallbackSummary = {
        trace_id: rec.trace_id,
        biz_key: rec.biz_key,
        target_url: parsedTarget.toString(),
        status,
        http_status: httpStatus,
        duration_ms: durationMs,
        error: errorMsg,
      };
      delivered.push(summary);
      options.onForwarded?.(summary);
    }

    if (options.once) {
      if (delivered.length > 0) {
        return delivered;
      }
      if (now() >= deadline) {
        throw new Error(
          `Timed out after ${options.timeoutMs}ms waiting for local://cli callback to forward.`,
        );
      }
    }

    await sleep(options.intervalMs);
  }
}
