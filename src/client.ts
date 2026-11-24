export interface VibeMockErrorPayload {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class VibeMockApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'VibeMockApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface VibeMockClientOptions {
  apiUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export class VibeMockClient {
  readonly apiUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: VibeMockClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async request<T = unknown>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    if (!this.token) {
      throw new Error(
        'Missing API token. Run `vibemock config set --token <token>` or set VIBEMOCK_TOKEN.',
      );
    }

    const url = new URL(`${this.apiUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    };

    let bodyStr: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(options.body);
    }

    const res = await this.fetchImpl(url.toString(), {
      method: options.method ?? 'GET',
      headers,
      body: bodyStr,
    });

    const text = await res.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const payload =
        parsed && typeof parsed === 'object' ? (parsed as VibeMockErrorPayload) : undefined;
      const code = payload?.error?.code ?? `HTTP_${res.status}`;
      const message =
        payload?.error?.message ??
        (typeof parsed === 'string' && parsed.trim()
          ? parsed.trim()
          : `Request failed with status ${res.status}`);
      throw new VibeMockApiError(res.status, code, message, payload?.error?.details);
    }

    return parsed as T;
  }
}
