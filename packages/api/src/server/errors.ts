/**
 * Domain-error → HTTP mapping. Every API failure is a structured JSON body:
 *
 *   { "error": { "code": "PROFILE_BUSY", "message": "..." } }
 *
 * `message` is safe to show (no secrets, no stack traces). Unexpected
 * errors become 500 INTERNAL_ERROR with a generic message; the details go
 * to the server log, never the wire.
 */

import { ChromiumNotFoundError } from '../browser/chromium.js';
import { InvalidProxyError } from '../browser/flags.js';
import { LaunchFailedError, LaunchTimeoutError } from '../browser/launcher.js';
import { ProfileNotFoundError } from '../profiles/lock.js';
import {
  AlreadyRunningError,
  ProfileBusyError,
  ProfileNotManagedError,
  ProfileStopTimeoutError,
} from '../profiles/manager.js';
import { ClientNotFoundError } from '../profiles/repository.js';
import { IllegalTransitionError } from '../profiles/states.js';
import { InvalidSecretRefError, ProxyNotFoundError } from '../proxies/repository.js';
import {
  ProxyCredentialError,
  ProxyRequiredError,
  ProxyUnhealthyError,
} from '../proxies/service.js';
import { TokenNotFoundError } from './tokens.js';
import { BodyTooLargeError, InvalidJsonError, ValidationError } from './router.js';

export interface HttpErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export interface MappedError {
  status: number;
  body: HttpErrorBody;
}

function mapped(status: number, code: string, message: string): MappedError {
  return { status, body: { error: { code, message } } };
}

export function toHttpError(error: unknown): MappedError {
  if (error instanceof ValidationError) {
    return mapped(400, 'VALIDATION_ERROR', error.message);
  }
  if (error instanceof InvalidJsonError) {
    return mapped(400, 'INVALID_JSON', error.message);
  }
  if (error instanceof BodyTooLargeError) {
    return mapped(413, 'BODY_TOO_LARGE', error.message);
  }
  if (error instanceof ClientNotFoundError) {
    return mapped(404, 'CLIENT_NOT_FOUND', error.message);
  }
  if (error instanceof ProfileNotFoundError) {
    return mapped(404, 'PROFILE_NOT_FOUND', error.message);
  }
  if (error instanceof ProxyNotFoundError) {
    return mapped(404, 'PROXY_NOT_FOUND', error.message);
  }
  if (error instanceof TokenNotFoundError) {
    return mapped(404, 'TOKEN_NOT_FOUND', error.message);
  }
  if (error instanceof AlreadyRunningError) {
    return mapped(409, 'PROFILE_ALREADY_RUNNING', error.message);
  }
  if (error instanceof ProfileBusyError) {
    return mapped(409, 'PROFILE_BUSY', error.message);
  }
  if (error instanceof ProfileNotManagedError) {
    return mapped(409, 'PROFILE_NOT_MANAGED', error.message);
  }
  if (error instanceof ProfileStopTimeoutError) {
    return mapped(504, 'PROFILE_STOP_TIMEOUT', error.message);
  }
  if (error instanceof IllegalTransitionError) {
    return mapped(409, 'ILLEGAL_STATE_TRANSITION', error.message);
  }
  if (error instanceof ProxyRequiredError) {
    return mapped(409, 'PROXY_REQUIRED', error.message);
  }
  if (error instanceof ProxyUnhealthyError) {
    // A dependency (the proxy) failed: 502 is the honest status.
    return mapped(502, 'PROXY_UNHEALTHY', error.message);
  }
  if (error instanceof ProxyCredentialError) {
    return mapped(500, 'PROXY_CREDENTIAL_ERROR', error.message);
  }
  if (error instanceof InvalidSecretRefError) {
    return mapped(400, 'INVALID_SECRET_REF', error.message);
  }
  if (error instanceof InvalidProxyError) {
    return mapped(400, 'INVALID_PROXY', error.message);
  }
  if (error instanceof ChromiumNotFoundError) {
    return mapped(500, 'CHROMIUM_NOT_FOUND', error.message);
  }
  if (error instanceof LaunchTimeoutError) {
    return mapped(504, 'LAUNCH_TIMEOUT', error.message);
  }
  if (error instanceof LaunchFailedError) {
    return mapped(500, 'LAUNCH_FAILED', error.message);
  }
  if (error instanceof Error && /^Cannot delete proxy .*: it is assigned to a profile$/.test(error.message)) {
    return mapped(409, 'PROXY_ASSIGNED', error.message);
  }
  if (error instanceof Error && error.message.startsWith('Token name must be ')) {
    return mapped(400, 'INVALID_TOKEN_NAME', error.message);
  }
  return mapped(500, 'INTERNAL_ERROR', 'Unexpected server error');
}

export function httpErrorBody(status: number, code: string, message: string): { status: number; body: HttpErrorBody } {
  return { status, body: { error: { code, message } } };
}
