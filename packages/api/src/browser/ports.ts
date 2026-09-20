/**
 * Free-port allocation for CDP endpoints.
 *
 * Binds port 0 on 127.0.0.1, reads the assigned port, and closes. There is
 * an inherent TOCTOU race (something else could grab the port before the
 * browser binds it); the launcher retries the whole spawn on EADDRINUSE.
 */

import { createServer } from 'node:net';

export async function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('Could not determine a free port'));
        }
      });
    });
  });
}
