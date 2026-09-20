/**
 * Minimal S3-compatible client (Phase 4b).
 *
 * Deliberately dependency-free: SigV4 request signing is implemented with
 * node:crypto (~80 lines) instead of pulling in an AWS SDK. The client is
 * provider-agnostic — it speaks plain S3 REST over HTTPS to any
 * S3-compatible endpoint (AWS, MinIO, Garage, etc.). Plain HTTP endpoints
 * are rejected unless `allowInsecureHttp` is explicitly set (local
 * MinIO/testing only).
 */

import { createHash, createHmac } from 'node:crypto';

export class S3InsecureEndpointError extends Error {
  constructor(endpoint: string) {
    super(
      `Refusing insecure S3 endpoint ${endpoint}: use https:// or set allowInsecureHttp explicitly for local testing`,
    );
  }
}

export class S3Error extends Error {
  readonly status: number;
  readonly code: string | null;
  /** Suggested HTTP status when surfaced through the API. */
  readonly httpStatus: number;
  constructor(status: number, message: string, code: string | null = null, httpStatus?: number) {
    super(message);
    this.status = status;
    this.code = code;
    // Real upstream statuses pass through; local failures (status 0) are
    // client errors unless the caller says otherwise (e.g. network → 502).
    this.httpStatus =
      httpStatus ?? (status >= 400 && status < 600 ? status : status === 0 ? 400 : 500);
  }
}

export interface S3ClientConfig {
  /** Full endpoint URL, e.g. https://s3.eu-central-1.amazonaws.com or http://localhost:9000 */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Opt-in for http:// endpoints (local MinIO/testing). Default false. */
  allowInsecureHttp?: boolean;
}

export interface S3ObjectInfo {
  key: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

export interface SignInput {
  method: string;
  url: string;
  headers?: Record<string, string> | undefined;
  /** Payload bytes; undefined means UNSIGNED-PAYLOAD (streaming/unknown length). */
  payload?: Buffer | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  now?: Date;
  /**
   * Include the x-amz-content-sha256 header (default true). Disable to
   * reproduce header-less AWS test vectors exactly.
   */
  includeContentSha256Header?: boolean;
}

/**
 * Sign an HTTP request with AWS Signature Version 4. Pure function —
 * exported for testing against the published AWS test vectors.
 */
export function signRequestV4(input: SignInput): {
  url: string;
  headers: Record<string, string>;
} {
  const service = input.service ?? 's3';
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const parsed = new URL(input.url);
  const payloadHash = input.payload === undefined ? 'UNSIGNED-PAYLOAD' : sha256Hex(input.payload);

  // Canonical URI: each path segment RFC-3986 encoded, '/' preserved.
  const canonicalUri = parsed.pathname
    .split('/')
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join('/');

  // Canonical query string: sorted by name, then value.
  const queryPairs: [string, string][] = [];
  parsed.searchParams.forEach((value, name) => {
    queryPairs.push([name, value]);
  });
  queryPairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const canonicalQueryString = queryPairs
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');

  const rawHeaders: Record<string, string> = {
    ...(input.headers ?? {}),
    host: parsed.host, // includes non-default port
    'x-amz-date': amzDate,
  };
  if (input.includeContentSha256Header ?? true) {
    rawHeaders['x-amz-content-sha256'] = payloadHash;
  }
  // Normalize to lowercase names and trim/collapse whitespace per SigV4.
  const normalized = new Map<string, string>();
  for (const [name, value] of Object.entries(rawHeaders)) {
    normalized.set(name.toLowerCase(), value.trim().replace(/\s+/g, ' '));
  }
  const sortedNames = [...normalized.keys()].sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${normalized.get(n) ?? ''}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, input.region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');

  const headers: Record<string, string> = {};
  for (const [name, value] of normalized) {
    headers[name] = value;
  }
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: input.url, headers };
}

function parseListBucketResult(xml: string): {
  objects: S3ObjectInfo[];
  isTruncated: boolean;
  nextToken: string | null;
} {
  const objects: S3ObjectInfo[] = [];
  const contents = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [];
  for (const block of contents) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1] ?? '';
    const size = Number(/<Size>([\s\S]*?)<\/Size>/.exec(block)?.[1] ?? '0');
    const lastModified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1] ?? null;
    const etagRaw = /<ETag>([\s\S]*?)<\/ETag>/.exec(block)?.[1] ?? null;
    objects.push({
      key,
      size: Number.isFinite(size) ? size : 0,
      lastModified,
      etag: etagRaw ? etagRaw.replace(/^"|"$/g, '') : null,
    });
  }
  return {
    objects,
    isTruncated: xml.includes('<IsTruncated>true</IsTruncated>'),
    nextToken: /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null,
  };
}

/** Minimal S3 REST client using path-style addressing. */
export class S3Client {
  private readonly endpoint: string;
  private readonly region: string;
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;

  constructor(config: S3ClientConfig) {
    const endpoint = config.endpoint.replace(/\/+$/, '');
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new S3Error(0, `Unsupported S3 endpoint protocol: ${parsed.protocol}`);
    }
    if (parsed.protocol === 'http:' && !config.allowInsecureHttp) {
      throw new S3InsecureEndpointError(endpoint);
    }
    if (!config.bucket || !/^[A-Za-z0-9._-]{1,255}$/.test(config.bucket)) {
      throw new S3Error(0, `Invalid S3 bucket name: ${config.bucket}`);
    }
    if (!config.accessKeyId || !config.secretAccessKey) {
      throw new S3Error(0, 'S3 credentials are required');
    }
    this.endpoint = endpoint;
    this.region = config.region;
    this.bucket = config.bucket;
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
  }

  private objectUrl(key: string, query = ''): string {
    const encodedKey = key
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `${this.endpoint}/${this.bucket}/${encodedKey}${query}`;
  }

  private async request(
    method: string,
    url: string,
    options: { headers?: Record<string, string>; body?: Buffer } = {},
  ): Promise<Response> {
    const signed = signRequestV4({
      method,
      url,
      headers: options.headers,
      payload: options.body,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
    });
    let res: Response;
    try {
      const init: RequestInit = { method, headers: signed.headers };
      if (options.body !== undefined) {
        init.body = options.body;
      }
      res = await fetch(signed.url, init);
    } catch (error) {
      throw new S3Error(
        0,
        `S3 request failed: ${error instanceof Error ? error.message : String(error)}`,
        null,
        502,
      );
    }
    return res;
  }

  private static async throwOnError(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => '');
    const code = /<Code>([\s\S]*?)<\/Code>/.exec(text)?.[1] ?? null;
    throw new S3Error(
      res.status,
      `S3 ${what} failed with status ${String(res.status)}${code ? ` (${code})` : ''}`,
      code,
    );
  }

  async putObject(key: string, body: Buffer): Promise<{ etag: string | null }> {
    const res = await this.request('PUT', this.objectUrl(key), {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
      },
      body,
    });
    if (!res.ok) {
      await S3Client.throwOnError(res, 'upload');
    }
    const etag = res.headers.get('etag');
    return { etag: etag ? etag.replace(/^"|"$/g, '') : null };
  }

  async getObject(key: string): Promise<Buffer> {
    const res = await this.request('GET', this.objectUrl(key));
    if (!res.ok) {
      await S3Client.throwOnError(res, 'download');
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async headObject(key: string): Promise<{ size: number; etag: string | null } | null> {
    const res = await this.request('HEAD', this.objectUrl(key));
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      await S3Client.throwOnError(res, 'stat');
    }
    const etag = res.headers.get('etag');
    return {
      size: Number(res.headers.get('content-length') ?? '0'),
      etag: etag ? etag.replace(/^"|"$/g, '') : null,
    };
  }

  async listObjects(prefix: string): Promise<S3ObjectInfo[]> {
    const out: S3ObjectInfo[] = [];
    let continuationToken: string | null = null;
    for (;;) {
      const params = new URLSearchParams({
        'list-type': '2',
        prefix,
        'max-keys': '1000',
      });
      if (continuationToken) {
        params.set('continuation-token', continuationToken);
      }
      const url = `${this.endpoint}/${this.bucket}/?${params.toString()}`;
      const res = await this.request('GET', url);
      if (!res.ok) {
        await S3Client.throwOnError(res, 'list');
      }
      const parsed = parseListBucketResult(await res.text());
      out.push(...parsed.objects);
      if (!parsed.isTruncated) {
        break;
      }
      continuationToken = parsed.nextToken;
      if (!continuationToken) {
        break;
      }
    }
    return out;
  }

  async deleteObject(key: string): Promise<void> {
    const res = await this.request('DELETE', this.objectUrl(key));
    if (!res.ok && res.status !== 404) {
      await S3Client.throwOnError(res, 'delete');
    }
  }
}
