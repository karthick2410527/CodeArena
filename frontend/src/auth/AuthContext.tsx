import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { authApi } from "../api/endpoints";
import {
  clearSession,
  getRefreshToken,
  refreshSession,
  setSessionExpiredHandler,
  storeSession,
} from "../api/client";
import type { User } from "../api/types";

type Status = "loading" | "authenticated" | "anonymous";

interface AuthContextValue {
  status: Status;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string, displayName?: string) => Promise<void>;
  /** Finishes a Google or GitHub sign-in with the one-time code from /auth/callback. */
  completeOAuth: (code: string) => Promise<void>;
  /** Re-reads the signed-in user, e.g. after connecting a provider. */
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<User | null>(null);

  // Restore the session after a page reload using the stored refresh token.
  useEffect(() => {
    let active = true;
    refreshSession()
      .then((auth) => {
        if (!active) return;
        if (auth) {
          setUser(auth.user);
          setStatus("authenticated");
        } else {
          setStatus("anonymous");
        }
      })
      .catch(() => {
        // API unreachable: stay logged out for now but keep the stored token for next time.
        if (active) setStatus("anonymous");
      });
    return () => {
      active = false;
    };
  }, []);

  // If a request discovers the session is no longer valid, drop to anonymous.
  useEffect(() => {
    setSessionExpiredHandler(() => {
      setUser(null);
      setStatus("anonymous");
      queryClient.clear();
    });
    return () => setSessionExpiredHandler(null);
  }, [queryClient]);

  const login = useCallback(async (email: string, password: string) => {
    const auth = await authApi.login({ email, password });
    storeSession(auth);
    setUser(auth.user);
    setStatus("authenticated");
  }, []);

  const register = useCallback(async (username: string, email: string, password: string, displayName?: string) => {
    const auth = await authApi.register({ username, email, password, display_name: displayName });
    storeSession(auth);
    setUser(auth.user);
    setStatus("authenticated");
  }, []);

  const completeOAuth = useCallback(async (code: string) => {
    const auth = await authApi.exchange(code);
    storeSession(auth);
    setUser(auth.user);
    setStatus("authenticated");
  }, []);

  const refreshUser = useCallback(async () => {
    setUser(await authApi.me());
  }, []);

  const logout = useCallback(async () => {
    const token = getRefreshToken();
    clearSession();
    setUser(null);
    setStatus("anonymous");
    queryClient.clear();
    if (token) {
      try {
        await authApi.logout(token);
      } catch {
        /* best effort: the token is already forgotten locally */
      }
    }
  }, [queryClient]);

  // Public pages answer differently for a signed-in caller (your progress,
  // your registration, a draft you author), so when who is signed in
  // changes, everything cached under the previous identity is refetched.
  const viewer = user?.id ?? null;
  const lastViewer = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (status === "loading") return;
    if (lastViewer.current !== undefined && lastViewer.current !== viewer) {
      void queryClient.invalidateQueries();
    }
    lastViewer.current = viewer;
  }, [status, viewer, queryClient]);

  const value = useMemo(
    () => ({ status, user, login, register, completeOAuth, refreshUser, logout }),
    [status, user, login, register, completeOAuth, refreshUser, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/**
 * For queries whose answer depends on who is asking: `ready` is false until a
 * stored session has been restored, so they never cache an anonymous answer
 * for a signed-in user.
 */
export function useViewer(): { ready: boolean; signedIn: boolean } {
  const { status } = useAuth();
  return { ready: status !== "loading", signedIn: status === "authenticated" };
}
