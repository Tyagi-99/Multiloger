/**
 * Encrypted secret vault (proxy credentials) + log redaction utilities.
 */

export {
  deleteSecret,
  getSecret,
  listSecretNames,
  resolveVaultKey,
  resolveVaultPath,
  storeSecret,
  VAULT_FILE_MODE,
  VAULT_MAGIC,
  VaultCorruptError,
  VaultError,
  VaultKeyError,
  VaultKeyMissingError,
  VaultKeyPermissionsError,
  VaultPermissionsError,
  type KeySource,
} from './vault.js';

export { maskSecret, redactSecretsDeep, redactSecretsText, REDACTED } from './redact.js';
