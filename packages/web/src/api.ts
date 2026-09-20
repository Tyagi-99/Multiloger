/**
 * Typed fetch client for the Multiloger REST API. Same-origin by default:
 * in dev the Vite proxy forwards /v1 and /health to the API server; in
 * production the API server serves this bundle itself.
 */

import type {
  ApiToken,
  AuditEntry,
  Backup,
  BackupVerification,
  Client,
  CloudSyncConfig,
  CloudSyncConfigInput,
  CloudSyncResult,
  IdentityInfo,
  InvitationInfo,
  LaunchReadiness,
  MonitoringSummary,
  ProfileDetail,
  PublicProxy,
  RemoteBackupObject,
  ResourceStatus,
  RoleInfo,
  Session,
  TeamUser,
} from './types.js';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function errorBodyOf(json: unknown): { code: string; message: string } | null {
  if (typeof json !== 'object' || json === null) {
    return null;
  }
  const error = (json as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || typeof message !== 'string') {
    return null;
  }
  return { code, message };
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;

  listClients(): Promise<{ clients: Client[] }>;
  createClient(name: string, notes?: string): Promise<{ client: Client }>;
  listProfiles(): Promise<{ profiles: ProfileDetail[] }>;
  createProfile(
    clientId: string,
    name: string,
    proxyRequired?: boolean,
  ): Promise<{ profile: ProfileDetail }>;
  getProfile(id: string): Promise<{ profile: ProfileDetail }>;
  launchProfile(
    id: string,
  ): Promise<{ profile: ProfileDetail; cdp: { pid: number; port: number; cdpUrl: string } }>;
  stopProfile(id: string): Promise<{ profile: ProfileDetail }>;
  restartProfile(
    id: string,
  ): Promise<{ profile: ProfileDetail; cdp: { pid: number; port: number; cdpUrl: string } }>;
  launchReadiness(id: string): Promise<LaunchReadiness>;
  getSessions(id: string): Promise<{ sessions: Session[] }>;
  assignProxy(profileId: string, proxyId: string): Promise<{ profile: ProfileDetail }>;
  unassignProxy(profileId: string): Promise<{ profile: ProfileDetail }>;

  listProxies(): Promise<{ proxies: PublicProxy[] }>;
  createProxy(input: {
    name: string;
    scheme: string;
    host: string;
    port: number;
    username?: string;
    password?: string;
    bypass?: string;
    notes?: string;
  }): Promise<{ proxy: PublicProxy }>;
  deleteProxy(id: string): Promise<{ deleted: boolean }>;
  checkProxyHealth(id: string): Promise<{ proxy: PublicProxy; health: unknown }>;

  listTokens(): Promise<{ tokens: ApiToken[] }>;
  createToken(
    name: string,
  ): Promise<{ id: string; name: string; token: string; createdAt: string }>;
  revokeToken(id: string): Promise<{ token: ApiToken }>;

  getIdentity(): Promise<{ identity: IdentityInfo }>;
  loginWithPassword(email: string, password: string): Promise<{ token: string }>;
  changePassword(currentPassword: string, newPassword: string): Promise<{ changed: boolean }>;

  listUsers(): Promise<{ users: TeamUser[] }>;
  createUser(input: {
    name: string;
    email: string;
    password: string;
    roleIds?: string[];
  }): Promise<{ user: TeamUser }>;
  updateUser(id: string, patch: { name?: string; disabled?: boolean }): Promise<{ user: TeamUser }>;
  deleteUser(id: string): Promise<{ deleted: boolean }>;
  assignRole(userId: string, roleId: string): Promise<{ user: TeamUser }>;
  removeRole(userId: string, roleId: string): Promise<{ user: TeamUser }>;
  grantClientAccess(userId: string, clientId: string): Promise<{ granted: boolean }>;
  revokeClientAccess(userId: string, clientId: string): Promise<{ revoked: boolean }>;
  grantProfileAccess(userId: string, profileId: string): Promise<{ granted: boolean }>;
  revokeProfileAccess(userId: string, profileId: string): Promise<{ revoked: boolean }>;
  getUserScopes(userId: string): Promise<{ scopes: { clients: string[]; profiles: string[] } }>;
  listUserTokens(userId: string): Promise<{ tokens: ApiToken[] }>;
  issueUserToken(
    userId: string,
    name: string,
    scopes?: string[],
  ): Promise<{ id: string; name: string; token: string; createdAt: string }>;

  listRoles(): Promise<{ roles: RoleInfo[] }>;
  createRole(input: {
    id: string;
    name: string;
    description?: string;
    permissions: string[];
  }): Promise<{
    role: RoleInfo;
  }>;
  deleteRole(id: string): Promise<{ deleted: boolean }>;

  listInvitations(): Promise<{ invitations: InvitationInfo[] }>;
  createInvitation(input: {
    email: string;
    roleId: string;
    clientIds?: string[];
    profileIds?: string[];
    expiresInHours?: number;
  }): Promise<{ invitation: InvitationInfo; token: string }>;
  revokeInvitation(id: string): Promise<{ revoked: boolean }>;

  queryAuditLog(params?: {
    action?: string;
    actorId?: string;
    entityType?: string;
    entityId?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ entries: AuditEntry[]; total: number; limit: number; offset: number }>;

  createBackup(profileId: string): Promise<{ backup: Backup }>;
  listBackups(profileId: string): Promise<{ backups: Backup[] }>;
  verifyBackup(backupId: string): Promise<BackupVerification>;
  restoreBackup(
    backupId: string,
    name: string,
    clientId?: string,
  ): Promise<{ profile: ProfileDetail }>;
  deleteBackup(backupId: string): Promise<{ deleted: boolean }>;

  resourceStatus(): Promise<ResourceStatus>;

  monitoringSummary(): Promise<MonitoringSummary>;

  cloudSyncConfig(): Promise<{ config: CloudSyncConfig }>;
  saveCloudSyncConfig(input: CloudSyncConfigInput): Promise<{ config: CloudSyncConfig }>;
  syncCloudNow(): Promise<CloudSyncResult>;
  listCloudObjects(): Promise<{ objects: RemoteBackupObject[] }>;
  restoreCloudObject(
    key: string,
    name: string,
    clientId?: string,
  ): Promise<{ backupId: string; profileId: string }>;
  pruneCloudObjects(): Promise<{ deleted: string[] }>;
}

export function createApiClient(baseUrl: string, getToken: () => string | null): ApiClient {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = getToken();
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, init);
    } catch (error) {
      throw new ApiError(
        0,
        'NETWORK_ERROR',
        error instanceof Error ? error.message : 'Network request failed',
      );
    }
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const parsed = errorBodyOf(json);
      throw new ApiError(
        res.status,
        parsed?.code ?? 'HTTP_ERROR',
        parsed?.message ?? `Request failed with status ${String(res.status)}`,
      );
    }
    return json as T;
  }

  const get = <T>(path: string): Promise<T> => request<T>('GET', path);
  const post = <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body);
  const put = <T>(path: string, body?: unknown): Promise<T> => request<T>('PUT', path, body);
  const patch = <T>(path: string, body?: unknown): Promise<T> => request<T>('PATCH', path, body);
  const del = <T>(path: string): Promise<T> => request<T>('DELETE', path);

  return {
    get,
    post,
    patch,
    del,
    listClients: () => get<{ clients: Client[] }>('/v1/clients'),
    createClient: (name, notes) =>
      post<{ client: Client }>('/v1/clients', notes === undefined ? { name } : { name, notes }),
    listProfiles: () => get<{ profiles: ProfileDetail[] }>('/v1/profiles'),
    createProfile: (clientId, name, proxyRequired) =>
      post<{ profile: ProfileDetail }>(
        '/v1/profiles',
        proxyRequired === undefined ? { clientId, name } : { clientId, name, proxyRequired },
      ),
    getProfile: (id) => get<{ profile: ProfileDetail }>(`/v1/profiles/${id}`),
    launchProfile: (id) =>
      post<{ profile: ProfileDetail; cdp: { pid: number; port: number; cdpUrl: string } }>(
        `/v1/profiles/${id}/launch`,
      ),
    stopProfile: (id) => post<{ profile: ProfileDetail }>(`/v1/profiles/${id}/stop`),
    restartProfile: (id) =>
      post<{ profile: ProfileDetail; cdp: { pid: number; port: number; cdpUrl: string } }>(
        `/v1/profiles/${id}/restart`,
      ),
    launchReadiness: (id) => get<LaunchReadiness>(`/v1/profiles/${id}/launch-readiness`),
    getSessions: (id) => get<{ sessions: Session[] }>(`/v1/profiles/${id}/sessions`),
    assignProxy: (profileId, proxyId) =>
      post<{ profile: ProfileDetail }>(`/v1/profiles/${profileId}/proxy`, { proxyId }),
    unassignProxy: (profileId) =>
      del<{ profile: ProfileDetail }>(`/v1/profiles/${profileId}/proxy`),

    listProxies: () => get<{ proxies: PublicProxy[] }>('/v1/proxies'),
    createProxy: (input) => post<{ proxy: PublicProxy }>('/v1/proxies', input),
    deleteProxy: (id) => del<{ deleted: boolean }>(`/v1/proxies/${id}`),
    checkProxyHealth: (id) =>
      post<{ proxy: PublicProxy; health: unknown }>(`/v1/proxies/${id}/health`),

    listTokens: () => get<{ tokens: ApiToken[] }>('/v1/tokens'),
    createToken: (name) =>
      post<{ id: string; name: string; token: string; createdAt: string }>('/v1/tokens', { name }),
    revokeToken: (id) => post<{ token: ApiToken }>(`/v1/tokens/${id}/revoke`),

    getIdentity: () => get<{ identity: IdentityInfo }>('/v1/auth/me'),
    loginWithPassword: (email, password) =>
      post<{
        user: TeamUser;
        token: { id: string; name: string; token: string; createdAt: string };
      }>('/v1/auth/login', { email, password }).then((res) => ({ token: res.token.token })),
    changePassword: (currentPassword, newPassword) =>
      post<{ changed: boolean }>('/v1/auth/password', { currentPassword, newPassword }),

    listUsers: () => get<{ users: TeamUser[] }>('/v1/users'),
    createUser: (input) => post<{ user: TeamUser }>('/v1/users', input),
    updateUser: (id, updates) => patch<{ user: TeamUser }>(`/v1/users/${id}`, updates),
    deleteUser: (id) => del<{ deleted: boolean }>(`/v1/users/${id}`),
    assignRole: (userId, roleId) =>
      post<{ user: TeamUser }>(`/v1/users/${userId}/roles`, { roleId }),
    removeRole: (userId, roleId) => del<{ user: TeamUser }>(`/v1/users/${userId}/roles/${roleId}`),
    grantClientAccess: (userId, clientId) =>
      post<{ granted: boolean }>(`/v1/users/${userId}/clients`, { clientId }),
    revokeClientAccess: (userId, clientId) =>
      del<{ revoked: boolean }>(`/v1/users/${userId}/clients/${clientId}`),
    grantProfileAccess: (userId, profileId) =>
      post<{ granted: boolean }>(`/v1/users/${userId}/profiles`, { profileId }),
    revokeProfileAccess: (userId, profileId) =>
      del<{ revoked: boolean }>(`/v1/users/${userId}/profiles/${profileId}`),
    getUserScopes: (userId) =>
      get<{ scopes: { clients: string[]; profiles: string[] } }>(`/v1/users/${userId}/scopes`),
    listUserTokens: (userId) => get<{ tokens: ApiToken[] }>(`/v1/users/${userId}/tokens`),
    issueUserToken: (userId, name, scopes) =>
      post<{ id: string; name: string; token: string; createdAt: string }>(
        `/v1/users/${userId}/tokens`,
        scopes === undefined ? { name } : { name, scopes },
      ),

    listRoles: () => get<{ roles: RoleInfo[] }>('/v1/roles'),
    createRole: (input) => post<{ role: RoleInfo }>('/v1/roles', input),
    deleteRole: (id) => del<{ deleted: boolean }>(`/v1/roles/${id}`),

    listInvitations: () => get<{ invitations: InvitationInfo[] }>('/v1/invitations'),
    createInvitation: (input) =>
      post<{ invitation: InvitationInfo; token: string }>('/v1/invitations', input),
    revokeInvitation: (id) => post<{ revoked: boolean }>(`/v1/invitations/${id}/revoke`),

    queryAuditLog: (params) => {
      const query = new URLSearchParams();
      const entries: [string, string | number][] = params
        ? (Object.entries(params) as [string, string | number | undefined][]).flatMap(
            ([key, value]) => (value === undefined ? [] : [[key, value]]),
          )
        : [];
      for (const [key, value] of entries) {
        query.set(key, String(value));
      }
      const suffix = query.toString();
      return get<{ entries: AuditEntry[]; total: number; limit: number; offset: number }>(
        suffix ? `/v1/audit-log?${suffix}` : '/v1/audit-log',
      );
    },

    createBackup: (profileId) => post<{ backup: Backup }>(`/v1/profiles/${profileId}/backups`),
    listBackups: (profileId) => get<{ backups: Backup[] }>(`/v1/profiles/${profileId}/backups`),
    verifyBackup: (backupId) => post<BackupVerification>(`/v1/backups/${backupId}/verify`),
    restoreBackup: (backupId, name, clientId) =>
      post<{ profile: ProfileDetail }>(
        `/v1/backups/${backupId}/restore`,
        clientId === undefined ? { name } : { name, clientId },
      ),
    deleteBackup: (backupId) => del<{ deleted: boolean }>(`/v1/backups/${backupId}`),

    resourceStatus: () => get<ResourceStatus>('/v1/resources'),
    monitoringSummary: () => get<MonitoringSummary>('/v1/monitoring/summary'),

    cloudSyncConfig: () => get<{ config: CloudSyncConfig }>('/v1/cloud-sync/config'),
    saveCloudSyncConfig: (input: CloudSyncConfigInput) =>
      put<{ config: CloudSyncConfig }>('/v1/cloud-sync/config', input),
    syncCloudNow: () => post<CloudSyncResult>('/v1/cloud-sync/sync'),
    listCloudObjects: () => get<{ objects: RemoteBackupObject[] }>('/v1/cloud-sync/objects'),
    restoreCloudObject: (key: string, name: string, clientId?: string) =>
      post<{ backupId: string; profileId: string }>(
        '/v1/cloud-sync/restore',
        clientId === undefined ? { key, name } : { key, name, clientId },
      ),
    pruneCloudObjects: () => post<{ deleted: string[] }>('/v1/cloud-sync/prune'),
  };
}

/** Extract a readable message from any thrown value. */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : 'Unknown error';
}
