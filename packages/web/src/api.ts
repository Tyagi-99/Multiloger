/**
 * Typed fetch client for the Multiloger REST API. Same-origin by default:
 * in dev the Vite proxy forwards /v1 and /health to the API server; in
 * production the API server serves this bundle itself.
 */

import type {
  ApiToken,
  Backup,
  BackupVerification,
  Client,
  LaunchReadiness,
  ProfileDetail,
  PublicProxy,
  ResourceStatus,
  Session,
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
  createProfile(clientId: string, name: string, proxyRequired?: boolean): Promise<{ profile: ProfileDetail }>;
  getProfile(id: string): Promise<{ profile: ProfileDetail }>;
  launchProfile(id: string): Promise<{ profile: ProfileDetail; cdp: { pid: number; port: number; cdpUrl: string } }>;
  stopProfile(id: string): Promise<{ profile: ProfileDetail }>;
  restartProfile(id: string): Promise<{ profile: ProfileDetail; cdp: { pid: number; port: number; cdpUrl: string } }>;
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
  createToken(name: string): Promise<{ token: ApiToken; plaintext: string }>;
  revokeToken(id: string): Promise<{ token: ApiToken }>;

  createBackup(profileId: string): Promise<{ backup: Backup }>;
  listBackups(profileId: string): Promise<{ backups: Backup[] }>;
  verifyBackup(backupId: string): Promise<BackupVerification>;
  restoreBackup(backupId: string, name: string, clientId?: string): Promise<{ profile: ProfileDetail }>;
  deleteBackup(backupId: string): Promise<{ deleted: boolean }>;

  resourceStatus(): Promise<ResourceStatus>;
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
      throw new ApiError(0, 'NETWORK_ERROR', error instanceof Error ? error.message : 'Network request failed');
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
    unassignProxy: (profileId) => del<{ profile: ProfileDetail }>(`/v1/profiles/${profileId}/proxy`),

    listProxies: () => get<{ proxies: PublicProxy[] }>('/v1/proxies'),
    createProxy: (input) => post<{ proxy: PublicProxy }>('/v1/proxies', input),
    deleteProxy: (id) => del<{ deleted: boolean }>(`/v1/proxies/${id}`),
    checkProxyHealth: (id) => post<{ proxy: PublicProxy; health: unknown }>(`/v1/proxies/${id}/health`),

    listTokens: () => get<{ tokens: ApiToken[] }>('/v1/tokens'),
    createToken: (name) => post<{ token: ApiToken; plaintext: string }>('/v1/tokens', { name }),
    revokeToken: (id) => post<{ token: ApiToken }>(`/v1/tokens/${id}/revoke`),

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
  };
}

/** Extract a readable message from any thrown value. */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : 'Unknown error';
}
