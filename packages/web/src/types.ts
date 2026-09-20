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

/** Phase 4a: one active alert from the monitoring service. */
export interface MonitoringAlert {
  id: string;
  severity: 'warning' | 'critical';
  message: string;
  at: string;
}

/** Phase 4a: point-in-time operational metrics. */
export interface SystemMetrics {
  at: string;
  uptimeSec: number;
  profiles: { total: number; byState: Record<string, number> };
  queue: { depth: number; queuedIds: string[] };
  disk: {
    freeBytes: number | null;
    totalBytes: number | null;
    watermarkBytes: number;
    belowWatermark: boolean;
  };
  sessions: { started: number; crashed: number; errored: number };
  runs: {
    total: number;
    completed: number;
    failed: number;
    timedOut: number;
    cancelled: number;
    failureRate: number;
  };
  backups: { count: number; totalBytes: number };
}

/** Phase 4a: GET /v1/monitoring/summary. */
export interface MonitoringSummary {
  metrics: SystemMetrics;
  alerts: MonitoringAlert[];
}

/** Phase 4b: public cloud-sync config (secret names only, never values). */
export interface CloudSyncConfig {
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  retentionDays: number;
  accessKeySecretName: string;
  secretKeySecretName: string;
  allowInsecureHttp: boolean;
  updatedAt: string;
}

/** Phase 4b: PUT /v1/cloud-sync/config body. */
export interface CloudSyncConfigInput {
  endpoint: string;
  bucket: string;
  region?: string;
  prefix?: string;
  retentionDays?: number;
  accessKeySecretName: string;
  secretKeySecretName: string;
  allowInsecureHttp?: boolean;
}

/** Phase 4b: GET /v1/cloud-sync/objects entry. */
export interface RemoteBackupObject {
  key: string;
  backupId: string | null;
  size: number;
  lastModified: string | null;
  etag: string | null;
}

/** Phase 4b: POST /v1/cloud-sync/sync result. */
export interface CloudSyncResult {
  uploaded: string[];
  skipped: string[];
  failed: { backupId: string; error: string }[];
}

/** Phase 4c: POST /v1/window-sync result. */
export interface WindowSyncResult {
  synced: string[];
  failed: { profileId: string; error: string }[];
}

/** Phase 2 automation script (latest version view). */
export interface AutomationScript {
  id: string;
  name: string;
  version: number;
  description?: string;
  steps: unknown[];
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  versionCount?: number;
}

/** One historical version of an automation script: the API lists version numbers. */
export type ScriptVersionNumber = number;

/** Phase 2 automation job: a script version pinned to one profile. */
export interface AutomationJob {
  id: string;
  name: string;
  scriptId: string;
  scriptVersion: number;
  profileId: string;
  status: string;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

/** One execution of an automation job. */
export interface AutomationRun {
  id: string;
  jobId: string;
  profileId: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  artifactCount: number;
  createdAt: string;
  updatedAt: string;
}
