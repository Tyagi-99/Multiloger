/**
 * SigV4 signing tests (Phase 4b).
 *
 * The first test pins an implementation golden value (regression guard only).
 * Real signature correctness is proven in cloudsync.test.ts, where an
 * independently written mock S3 server recomputes every signature from the
 * wire bytes and rejects mismatches.
 */

import { describe, expect, it } from 'vitest';
import { S3Client, S3Error, S3InsecureEndpointError, signRequestV4 } from './s3.js';

describe('signRequestV4', () => {
  it('pins a golden signature for a fixed input (regression guard)', () => {
    // Implementation-pinned golden value: any change to canonicalization
    // or key derivation fails loudly here. (Cross-checked structurally
    // against the SigV4 spec; the mock S3 server in cloudsync.test.ts
    // independently re-verifies signatures from the wire bytes.)
    const signed = signRequestV4({
      method: 'GET',
      url: 'https://example.amazonaws.com/bucket/key?Param1=value1',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 's3',
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
        'Signature=4c591fd232fc603e48341c800085e3cb4075788f8a8acd6323058ddb469a856d',
    );
  });

  it('produces different signatures for different secrets', () => {
    const base = {
      method: 'GET',
      url: 'https://s3.example.com/bucket/key',
      accessKeyId: 'AKID',
      region: 'us-east-1',
      now: new Date('2026-01-01T00:00:00Z'),
    };
    const a = signRequestV4({ ...base, secretAccessKey: 'secret-a' });
    const b = signRequestV4({ ...base, secretAccessKey: 'secret-b' });
    expect(a.headers.authorization).not.toBe(b.headers.authorization);
  });

  it('signs the payload hash into the canonical request', () => {
    const signed = signRequestV4({
      method: 'PUT',
      url: 'https://s3.example.com/bucket/key',
      payload: Buffer.from('hello'),
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      region: 'us-east-1',
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(signed.headers['x-amz-content-sha256']).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

describe('S3Client construction', () => {
  const base = {
    region: 'us-east-1',
    bucket: 'my-bucket',
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
  };

  it('accepts https endpoints', () => {
    expect(() => new S3Client({ ...base, endpoint: 'https://s3.example.com' })).not.toThrow();
  });

  it('rejects http endpoints unless explicitly opted in', () => {
    expect(() => new S3Client({ ...base, endpoint: 'http://localhost:9000' })).toThrow(
      S3InsecureEndpointError,
    );
    expect(
      () => new S3Client({ ...base, endpoint: 'http://localhost:9000', allowInsecureHttp: true }),
    ).not.toThrow();
  });

  it('rejects non-http(s) protocols', () => {
    expect(() => new S3Client({ ...base, endpoint: 'ftp://example.com' })).toThrow(S3Error);
  });

  it('rejects invalid bucket names', () => {
    expect(() => new S3Client({ ...base, endpoint: 'https://s3.example.com', bucket: '' })).toThrow(
      S3Error,
    );
    expect(
      () => new S3Client({ ...base, endpoint: 'https://s3.example.com', bucket: '../evil' }),
    ).toThrow(S3Error);
  });
});
