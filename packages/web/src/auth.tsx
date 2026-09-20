/**
 * Token auth: the API token lives in localStorage (ops dashboard, single
 * user). The login screen validates the token against the API before
 * storing it, so a typo surfaces immediately instead of failing every
 * request later.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, createApiClient, messageOf, type ApiClient } from './api.js';

const STORAGE_KEY = 'multiloger.token';

interface AuthState {
  token: string | null;
  client: ApiClient;
  login: (token: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

function readStoredToken(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const tokenRef = useRef<string | null>(token);
  tokenRef.current = token;

  const client = useMemo(() => createApiClient('', () => tokenRef.current), []);

  const login = useCallback(
    async (next: string) => {
      const trimmed = next.trim();
      if (!trimmed) {
        throw new Error('Token is required');
      }
      // Validate before storing: a cheap authenticated call.
      const probe = createApiClient('', () => trimmed);
      try {
        await probe.resourceStatus();
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          throw new Error('Invalid token: the API rejected it (401)');
        }
        throw new Error(`Could not reach the API: ${messageOf(error)}`);
      }
      try {
        window.localStorage.setItem(STORAGE_KEY, trimmed);
      } catch {
        // Storage unavailable (private mode): keep it in memory only.
      }
      setToken(trimmed);
    },
    [],
  );

  const logout = useCallback(() => {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setToken(null);
  }, []);

  const value = useMemo(() => ({ token, client, login, logout }), [token, client, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const state = useContext(AuthContext);
  if (!state) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return state;
}
