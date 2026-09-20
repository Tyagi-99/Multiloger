/**
 * Minimal typed HTTP client for the Multiloger REST API.
 *
 * This is the ONLY way the MCP server talks to Multiloger: plain HTTP calls
 * with a bearer token. It never spawns browsers, never touches the SQLite
 * database, and never imports from @multiloger/api.
 */

const JSON_MIME = 'application/json';

/** Error thrown when the API rejects a request or cannot be reached. */
export class ApiClientError extends Error {
  /** HTTP status code, or 0 when the request never reached the API. */
  readonly status: number;
  /** Machine-readable error code from the API (or a local pseudo-code). */
  readonly code: string;

  constructor(status: number, code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
  }
}

/** Structural subset of the API's {error:{code,message}} body. */
interface ApiErrorBody {
  error: {
    code?: unknown;
    message?: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return isRecord(value) && isRecord(value.error);
}

/** Narrow the API's error body (or a fallback) into a status/code/message triple. */
function toApiClientError(status: number, body: unknown): ApiClientError {
  if (isApiErrorBody(body)) {
    const code = typeof body.error.code === 'string' ? body.error.code : `HTTP_${String(status)}`;
    const message =
      typeof body.error.message === 'string'
        ? body.error.message
        : `Request failed (${String(status)})`;
    return new ApiClientError(status, code, message);
  }
  return new ApiClientError(
    status,
    `HTTP_${String(status)}`,
    `Request failed with status ${String(status)}`,
  );
}

/** Client shape the tool layer depends on; lets tests inject a mock. */
export interface ApiClientLike {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** Fetch a binary response (artifact downloads). */
  requestBinary(path: string): Promise<{ data: Uint8Array; contentType: string }>;
}

/** Thin fetch wrapper that adds auth + JSON handling to every API call. */
export class MultilogerApiClient implements ApiClientLike {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    // Strip trailing slashes so path joins are predictable.
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: JSON_MIME,
          'Content-Type': JSON_MIME,
        },
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      throw new ApiClientError(
        0,
        'NETWORK_ERROR',
        `Could not reach the Multiloger API at ${this.baseUrl}${path}`,
        { cause },
      );
    }

    const text = await response.text();
    let data: unknown;
    if (text.length > 0) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = undefined;
      }
    }

    if (!response.ok) {
      throw toApiClientError(response.status, data);
    }
    return data as T;
  }

  async requestBinary(path: string): Promise<{ data: Uint8Array; contentType: string }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}`, Accept: '*/*' },
      });
    } catch (cause) {
      throw new ApiClientError(
        0,
        'NETWORK_ERROR',
        `Could not reach the Multiloger API at ${this.baseUrl}${path}`,
        { cause },
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let body: unknown;
      try {
        body = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
      } catch {
        body = undefined;
      }
      throw toApiClientError(response.status, body);
    }
    const buffer = await response.arrayBuffer();
    return {
      data: new Uint8Array(buffer),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}

/* ------------------------------------------------------------------ */
/* Loose structural types for the API responses the tools consume.     */
/* Extra fields the API returns are ignored; missing fields surface    */
/* as "unknown" in tool output rather than crashing a handler.         */
/* ------------------------------------------------------------------ */

export interface ApiProfile {
  id: string;
  clientId: string;
  name: string;
  state: string;
  proxyRequired: boolean;
  lastPid: number | null;
  lastCdpPort: number | null;
  lastLaunchedAt: string | null;
  [key: string]: unknown;
}

export interface ApiCdpInfo {
  pid: number;
  port: number;
  cdpUrl: string;
  [key: string]: unknown;
}

export interface ApiAutomationScript {
  id: string;
  name: string;
  version: number;
  description: string | null;
  steps: unknown[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface ApiAutomationJob {
  id: string;
  name: string;
  scriptId: string;
  scriptVersion: number | null;
  profileId: string;
  createdBy: string;
  status: string;
  timeoutMs: number | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface ApiRunLogEntry {
  at: string;
  stepIndex: number;
  message: string;
  [key: string]: unknown;
}

export interface ApiRunStepResult {
  index: number;
  type: string;
  ok: boolean;
  durationMs: number;
  output?: unknown;
  [key: string]: unknown;
}

export interface ApiRunArtifact {
  name: string;
  sizeBytes: number;
  [key: string]: unknown;
}

export interface ApiAutomationRun {
  id: string;
  jobId: string;
  profileId: string;
  status: string;
  timeoutMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  logs: ApiRunLogEntry[];
  result: { steps: ApiRunStepResult[]; artifacts?: ApiRunArtifact[] } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}
