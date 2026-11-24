import type { VibeMockClient } from './client.js';

export const TERMINAL_CALLBACK_STATUSES = new Set(['none', 'sent', 'failed', 'skipped']);

export interface MockRecord {
  trace_id: string;
  appid: string;
  env: string;
  biz_key: string | null;
  inbound_method?: string;
  inbound_path?: string;
  method?: string;
  path?: string;
  callback_status: string;
  sync_status: number;
  callback_response_status?: number | null;
  callback_http_status?: number | null;
  inbound_body: string | null;
  inbound_body_truncated: number;
  callback_response_body: string | null;
  created_at: string;
  [key: string]: unknown;
}

export interface WaitForRecordOptions {
  appid?: string;
  env?: string;
  bizKey?: string;
  traceId?: string;
  timeoutMs: number;
  intervalMs: number;
  consume?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface WaitForRecordResult {
  record: MockRecord;
  attempts: number;
  elapsed_ms: number;
  consumed: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForRecord(
  client: VibeMockClient,
  options: WaitForRecordOptions,
): Promise<WaitForRecordResult> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const deadline = startedAt + options.timeoutMs;
  let attempts = 0;
  let lastRecord: MockRecord | undefined;

  while (true) {
    attempts += 1;
    let candidate: MockRecord | undefined;

    if (options.traceId) {
      try {
        const res = await client.request<{ record: MockRecord }>(
          `/_inspect/records/${encodeURIComponent(options.traceId)}`,
        );
        candidate = res.record;
      } catch (err) {
        // Record may not exist yet; retry until timeout if 404.
        if (
          !(err instanceof Error && 'status' in err && (err as { status: number }).status === 404)
        ) {
          throw err;
        }
      }
    } else {
      const res = await client.request<{ records: MockRecord[] }>('/_inspect/records', {
        query: {
          appid: options.appid,
          env: options.env,
          biz_key: options.bizKey,
          limit: 1,
        },
      });
      candidate = res.records[0];
    }

    if (candidate) {
      lastRecord = candidate;
      if (TERMINAL_CALLBACK_STATUSES.has(candidate.callback_status)) {
        let consumed = false;
        if (options.consume) {
          await client.request(`/_inspect/records/${encodeURIComponent(candidate.trace_id)}`, {
            query: { consume: true },
          });
          consumed = true;
        }
        return {
          record: candidate,
          attempts,
          elapsed_ms: now() - startedAt,
          consumed,
        };
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      const detail = lastRecord
        ? `last record ${lastRecord.trace_id} still has callback_status="${lastRecord.callback_status}"`
        : 'no matching record arrived';
      throw new Error(`Timed out after ${options.timeoutMs}ms waiting for record (${detail}).`);
    }

    await sleep(Math.min(options.intervalMs, remaining));
  }
}
