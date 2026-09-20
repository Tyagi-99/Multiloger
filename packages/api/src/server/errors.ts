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
  ProxyAuthUnsupportedError,
  ProxyCredentialError,
  ProxyRequiredError,
  ProxyUnhealthyError,
} from '../proxies/service.js';
import { InsufficientDiskSpaceError, LaunchQueueTimeoutError } from '../resources/manager.js';
import { BackupBusyError, BackupCorruptError, BackupNotFoundError } from '../backups/service.js';
import { S3Error, S3InsecureEndpointError } from '../cloudsync/s3.js';
import { WindowSyncUrlError } from '../windowsync/service.js';
import {
  CloudSyncClientRequiredError,
  CloudSyncCredentialsError,
  CloudSyncIntegrityError,
  CloudSyncNotConfiguredError,
} from '../cloudsync/service.js';
import {
  JobNotFoundError,
  RunNotFoundError,
  ScriptNotFoundError,
} from '../automation/repository.js';
import {
  ArtifactNotFoundError,
  InvalidArtifactNameError,
  ProfileNotRunningError,
} from './automation-routes.js';
import { ScriptValidationError } from '../automation/script.js';
import {
  BackupKeyError,
  BackupKeyMissingError,
  BackupKeyPermissionsError,
} from '../backups/crypto.js';
import { TokenNotFoundError } from './tokens.js';
import { BodyTooLargeError, InvalidJsonError, ValidationError } from './router.js';
import { ForbiddenError, IdentityRejectedError } from './access.js';
import { InvalidCredentialsError } from './team-routes.js';
import { RoleNotFoundError, UserNotFoundError } from './users.js';
import {
  InvitationExpiredError,
  InvitationInvalidError,
  InvitationNotFoundError,
} from './invitations.js';

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
  if (error instanceof ScriptValidationError) {
    return mapped(400, 'INVALID_SCRIPT', error.message);
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
  if (error instanceof IdentityRejectedError) {
    return mapped(401, 'UNAUTHORIZED', error.message);
  }
  if (error instanceof InvalidCredentialsError) {
    return mapped(401, 'INVALID_CREDENTIALS', error.message);
  }
  if (error instanceof ForbiddenError) {
    return mapped(403, 'FORBIDDEN', error.message);
  }
  if (error instanceof UserNotFoundError) {
    return mapped(404, 'USER_NOT_FOUND', error.message);
  }
  if (error instanceof RoleNotFoundError) {
    return mapped(404, 'ROLE_NOT_FOUND', error.message);
  }
  if (error instanceof InvitationNotFoundError) {
    return mapped(404, 'INVITATION_NOT_FOUND', error.message);
  }
  if (error instanceof InvitationExpiredError) {
    return mapped(410, 'INVITATION_EXPIRED', error.message);
  }
  if (error instanceof InvitationInvalidError) {
    return mapped(400, 'INVITATION_INVALID', error.message);
  }
  if (error instanceof RunNotFoundError) {
    return mapped(404, 'RUN_NOT_FOUND', error.message);
  }
  if (error instanceof JobNotFoundError) {
    return mapped(404, 'JOB_NOT_FOUND', error.message);
  }
  if (error instanceof ScriptNotFoundError) {
    return mapped(404, 'SCRIPT_NOT_FOUND', error.message);
  }
  if (error instanceof ProfileNotRunningError) {
    return mapped(409, 'PROFILE_NOT_RUNNING', error.message);
  }
  if (error instanceof InvalidArtifactNameError) {
    return mapped(400, 'INVALID_ARTIFACT_NAME', error.message);
  }
  if (error instanceof ArtifactNotFoundError) {
    return mapped(404, 'ARTIFACT_NOT_FOUND', error.message);
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
  if (error instanceof LaunchQueueTimeoutError) {
    return mapped(503, 'LAUNCH_QUEUE_TIMEOUT', error.message);
  }
  if (error instanceof InsufficientDiskSpaceError) {
    return mapped(503, 'INSUFFICIENT_DISK_SPACE', error.message);
  }
  if (error instanceof BackupNotFoundError) {
    return mapped(404, 'BACKUP_NOT_FOUND', error.message);
  }
  if (error instanceof BackupKeyMissingError) {
    return mapped(503, 'BACKUP_KEY_MISSING', error.message);
  }
  if (error instanceof BackupKeyPermissionsError || error instanceof BackupKeyError) {
    return mapped(500, 'BACKUP_KEY_INVALID', error.message);
  }
  if (error instanceof BackupCorruptError) {
    return mapped(422, 'BACKUP_CORRUPT', error.message);
  }
  if (error instanceof BackupBusyError) {
    return mapped(409, 'BACKUP_BUSY', error.message);
  }
  if (error instanceof S3InsecureEndpointError) {
    return mapped(400, 'CLOUD_SYNC_INSECURE_ENDPOINT', error.message);
  }
  if (error instanceof CloudSyncNotConfiguredError) {
    return mapped(409, 'CLOUD_SYNC_NOT_CONFIGURED', error.message);
  }
  if (error instanceof CloudSyncCredentialsError) {
    return mapped(400, 'CLOUD_SYNC_CREDENTIALS', error.message);
  }
  if (error instanceof CloudSyncIntegrityError) {
    return mapped(422, 'CLOUD_SYNC_INTEGRITY', error.message);
  }
  if (error instanceof CloudSyncClientRequiredError) {
    return mapped(400, 'CLOUD_SYNC_CLIENT_REQUIRED', error.message);
  }
  if (error instanceof S3Error) {
    return mapped(error.httpStatus, 'CLOUD_SYNC_ERROR', error.message);
  }
  if (error instanceof WindowSyncUrlError) {
    return mapped(400, 'WINDOW_SYNC_INVALID_URL', error.message);
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
  if (error instanceof ProxyAuthUnsupportedError) {
    // The launch is refused because credentials are configured but cannot be
    // applied — a conflict between the request and the proxy's state.
    return mapped(409, 'PROXY_AUTH_UNSUPPORTED', error.message);
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
  if (
    error instanceof Error &&
    /^Cannot delete proxy .*: it is assigned to a profile$/.test(error.message)
  ) {
    return mapped(409, 'PROXY_ASSIGNED', error.message);
  }
  if (error instanceof Error && error.message.startsWith('Token name must be ')) {
    return mapped(400, 'INVALID_TOKEN_NAME', error.message);
  }
  return mapped(500, 'INTERNAL_ERROR', 'Unexpected server error');
}

export function httpErrorBody(
  status: number,
  code: string,
  message: string,
): { status: number; body: HttpErrorBody } {
  return { status, body: { error: { code, message } } };
}
