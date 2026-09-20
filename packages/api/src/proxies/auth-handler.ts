/**
 * CDP proxy-auth handler: answers HTTP proxy 407 challenges with the
 * operator's own vault-backed credentials via Fetch.continueWithAuth.
 *
 * This is legitimate multi-client proxy management only — it supplies the
 * operator's own proxy credentials to the operator's own Chromium. It does
 * not bypass platform security, defeat CAPTCHAs, or evade bans.
 *
 * How it works on current Chromium (verified against 152):
 * - Fetch.enable({ handleAuthRequests: true }) makes the browser pause page
 *   requests up front as Fetch.requestPaused interception jobs. Every such
 *   pause MUST be answered (Fetch.continueRequest) or the page hangs — the
 *   handler continues them all unmodified.
 * - When the proxy answers 407, Fetch.authRequired fires for the same
 *   interception-job requestId carrying the auth challenge. A challenge
 *   whose source is the proxy is answered with ProvideCredentials and the
 *   pair from getCredentials(); any other challenger (e.g. an origin
 *   server's 401) gets Default so proxy credentials are never offered to a
 *   non-proxy party. Note the wire value is "Proxy" (capital P) — the source
 *   comparison is case-insensitive.
 *
 * Credential hygiene: the username/password are only ever read from the
 * getCredentials() closure at challenge time and placed directly into the
 * CDP command params. They are never stored on the handle, never logged —
 * every log/error path is wrapped in redactSecretsText, and only
 * proxy-agnostic facts (challenge source, counts) are logged.
 */

import { createCdpEventSession } from '../browser/cdp.js';
import { redactSecretsText } from '../vault/index.js';
import type { ResolvedProxyCredentials } from './service.js';

/** Lifetime handle for an attached proxy-auth session. */
export interface ProxyAuthHandle {
  /** Best-effort synchronous teardown of the CDP session. */
  close: () => void;
  /** Resolves when the underlying CDP socket closes for any reason. */
  closed: Promise<void>;
}

interface RequestPausedParams {
  requestId?: string;
}

interface AuthRequiredParams {
  requestId?: string;
  authChallenge?: { source?: string };
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Attach to the browser's CDP endpoint and answer proxy authentication
 * challenges. See the module doc for the event flow.
 *
 * Every paused request and every auth challenge MUST be answered — a
 * challenge whose credential lookup fails is answered Default (with a
 * redacted error logged) so nothing hangs.
 */
export async function attachProxyAuth(
  wsUrl: string,
  getCredentials: () => ResolvedProxyCredentials,
  opts?: { timeoutMs?: number },
): Promise<ProxyAuthHandle> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const session = await createCdpEventSession(wsUrl, timeoutMs);
  try {
    await session.send('Fetch.enable', { handleAuthRequests: true });
  } catch (error) {
    // Never leave a half-attached session behind.
    session.close();
    throw error;
  }

  // With handleAuthRequests enabled, page requests pause up front as
  // interception jobs. Continue them all unmodified — authentication
  // challenges surface separately via Fetch.authRequired.
  session.onEvent('Fetch.requestPaused', (params: unknown) => {
    const requestId = (params as RequestPausedParams).requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return;
    }
    void session
      .send('Fetch.continueRequest', { requestId })
      .catch(() => undefined);
  });

  session.onEvent('Fetch.authRequired', (params: unknown) => {
    const challenge = params as AuthRequiredParams;
    const requestId = challenge.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return;
    }
    // Wire value is "Proxy" (CDP enum); compare case-insensitively.
    if (challenge.authChallenge?.source?.toLowerCase() === 'proxy') {
      let credentials: ResolvedProxyCredentials;
      try {
        credentials = getCredentials();
      } catch (error) {
        // The lookup never produced a password, so there is nothing to
        // redact — the empty list keeps the every-log-goes-through-redaction
        // invariant without implying otherwise.
        console.error(
          redactSecretsText(
            `[multiloger] proxy auth credential lookup failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            [],
          ),
        );
        void answerDefault(session, requestId);
        return;
      }
      void session
        .send('Fetch.continueWithAuth', {
          requestId,
          authChallengeResponse: {
            response: 'ProvideCredentials',
            username: credentials.username,
            password: credentials.password,
          },
        })
        .catch((error: unknown) => {
          // Defense in depth: the CDP transport error cannot contain the
          // password, but we had it in scope here, so redact it anyway.
          console.error(
            redactSecretsText(
              `[multiloger] proxy auth continueWithAuth failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              [credentials.password],
            ),
          );
        });
      return;
    }
    // Not our proxy — never answer a server challenge with proxy credentials.
    void answerDefault(session, requestId);
  });

  return {
    close: () => { session.close(); },
    closed: session.closed,
  };
}

function answerDefault(
  session: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  requestId: string,
): Promise<void> {
  return session
    .send('Fetch.continueWithAuth', {
      requestId,
      authChallengeResponse: { response: 'Default' },
    })
    .then(
      () => undefined,
      () => undefined,
    );
}
