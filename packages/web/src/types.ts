/**
 * TypeScript mirrors of the Multiloger API response shapes. The dashboard
 * treats these as read contracts: if the API changes shape, the UI fails
 * loudly at runtime (see api.ts ApiError) rather than rendering garbage.
 */

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export interface Client {
  id: string;
  name: string;
  notes: string | null;
  created_at: string;
}

export interface PublicProxy {
  id: string;
  name: string;
  scheme: string;
  host: string;
  port: number;
  username: string | null;
  has_credentials: boolean;
  bypass: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProfileLock {
  owner: string | null;
  lockedAt: string | null;
  active: boolean;
}

export interface ProfileDetail {
  id: string;
  clientId: string;
  name: string;
  state: string;
  proxyRequired: boolean;
  lastPid: number | null;
  lastCdpPort: number | null;
  lastLaunchedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lock: ProfileLock;
  proxy: PublicProxy | null;
}

export interface Session {
  id: string;
  profile_id: string;
  pid: number | null;
  cdp_port: number | null;
  started_at: string;
  ended_at: string | null;
  exit_reason: string | null;
}

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** Phase 3: user attribution and scope narrowing (absent on legacy tokens). */
  userId: string | null;
  scopes: string[] | null;
  createdBy: string | null;
}

/** Phase 3: a team user as returned by the API. */
export interface TeamUser {
  id: string;
  name: string;
  email: string;
  disabled: boolean;
  roles: string[];
  createdAt: string;
  updatedAt: string;
}

/** Phase 3: a role with its permission keys. */
export interface RoleInfo {
  id: string;
  name: string;
  description: string | null;
  seeded: boolean;
  permissions: string[];
}

/** Phase 3: a pending invitation (the plaintext token is shown once at creation). */
export interface InvitationInfo {
  id: string;
  email: string;
  roleId: string;
  clientIds: string[];
  profileIds: string[];
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

/** Phase 3: one audit-log entry. */
export interface AuditEntry {
  id: string;
  at: string;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: unknown;
  ip: string | null;
}

/** Phase 3: the caller's identity as reported by GET /v1/auth/me. */
export interface IdentityInfo {
  kind: 'legacy' | 'user';
  userId: string | null;
  tokenId: string;
  legacy: boolean;
  isAdmin: boolean;
  permissions: string[];
  scopes: string[] | null;
  user: TeamUser | null;
}

export interface Backup {
  id: string;
  profileId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  encryption: string;
  createdAt: string;
  stoppedForBackup?: boolean;
}

export interface BackupVerification {
  ok: boolean;
  backupId: string;
  sizeBytes: number;
  sha256: string;
  sha256Match: boolean;
  entries: number;
}

export interface ResourceStatus {
  enabled: boolean;
  maxConcurrent?: number;
  running?: number;
  queued?: string[];
  idleShutdownMs?: number | null;
  minFreeDiskBytes?: number;
}

export interface LaunchReadiness {
  ready: boolean;
  reason?: string;
  proxy?: { scheme: string; host: string; port: number } | null;
}

/** Domain event broadcast over /v1/events. */
export interface DomainEvent {
  type: string;
  [key: string]: unknown;
}
