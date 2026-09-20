/** Control-plane API server. HTTP routes land here starting in Task 7. */
export const API_VERSION = '0.1.0';

export function createApiInfo(): { name: string; version: string } {
  return { name: 'multiloger-api', version: API_VERSION };
}
