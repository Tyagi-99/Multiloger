/** Public proxy API: repository + health + launch-gate service. */

export {
  assignProxyToProfile,
  createProxy,
  deleteProxy,
  getAssignedProxy,
  getProxy,
  listProxies,
  setProxyRequired,
  toPublicProxy,
  unassignProxyFromProfile,
  updateProxy,
  InvalidSecretRefError,
  ProxyNotFoundError,
  type CreateProxyInput,
  type ProxyRecord,
  type PublicProxy,
  type UpdateProxyInput,
} from './repository.js';
export { checkProxyHealth, type ProxyHealth } from './health.js';
export {
  ensureWebrtcPolicy,
  type WebrtcIpHandlingPolicy,
} from './leak-guards.js';
export {
  resolveProxyForLaunch,
  resolveProxyCredentials,
  ProxyCredentialError,
  ProxyRequiredError,
  ProxyUnhealthyError,
  type ResolvedProxyCredentials,
} from './service.js';
export type { ProxyFlagOptions } from '../browser/flags.js';
