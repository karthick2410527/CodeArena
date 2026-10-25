import type { AuthResponse } from "./types";

const BASE = `${import.meta.env.VITE_API_BASE_URL ?? ""}/api/v1`;

/** The API's base URL, for what cannot go through `request` (EventSource). */
export function apiBase() {
  return BASE;
}
const REFRESH_KEY = "voidrun.refresh_token";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

// ---- token storage -------------------------------------------------------
// Access token: memory only (short-lived). Refresh token: localStorage, so a
// page reload can restore the session. Refresh tokens rotate on every use.
let accessToken: string | null = null;

export function getRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

function setRefreshToken(token: string | null) {
  try {
    if (token) localStorage.setItem(REFRESH_KEY, token);
    else localStorage.removeItem(REFRESH_KEY);
  } catch {
    /* storage unavailable: session simply won't survive reloads */
  }
}

export function storeSession(auth: AuthResponse) {
  accessToken = auth.access_token;
  setRefreshToken(auth.refresh_token);
}

export function clearSession() {
  accessToken = null;
  setRefreshToken(null);
}

// ---- refresh (single flight) --------------------------------------------
// Refresh tokens are single-use, so concurrent callers must share one request.
let refreshInFlight: Promise<AuthResponse | null> | null = null;

type SessionExpiredHandler = () => void;
let onSessionExpired: SessionExpiredHandler | null = null;
export function setSessionExpiredHandler(h: SessionExpiredHandler | null) {
  onSessionExpired = h;
}

/** Returns the new session, or null when there is no valid refresh token. Throws on network errors. */
export function refreshSession(): Promise<AuthResponse | null> {
  if (refreshInFlight) return refreshInFlight;
  const token = getRefreshToken();
  if (!token) return Promise.resolve(null);

  refreshInFlight = (async () => {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: token }),
    });
    if (res.ok) {
      const auth = (await res.json()) as AuthResponse;
      storeSession(auth);
      return auth;
    }
    if (res.status === 401 || res.status === 400) {
      clearSession();
      return null;
    }
    throw new ApiError(res.status, "REFRESH_FAILED", "Could not refresh the session");
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

// ---- requests ------------------------------------------------------------
interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  /** Attach the access token and transparently refresh once on 401. Default true. */
  auth?: boolean;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions["query"]) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return `${BASE}${path}${qs ? `?${qs}` : ""}`;
}

async function parseError(res: Response): Promise<ApiError> {
  let code = "HTTP_ERROR";
  let message = `Request failed (${res.status})`;
  try {
    const data = await res.json();
    if (data?.error) {
      code = data.error.code ?? code;
      message = data.error.message ?? message;
    }
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, code, message);
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.auth !== false && accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  return fetch(buildUrl(path, opts.query), {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let res = await send(path, opts);

  if (res.status === 401 && opts.auth !== false && getRefreshToken()) {
    const refreshed = await refreshSession();
    if (refreshed) {
      res = await send(path, opts);
    } else {
      onSessionExpired?.();
    }
  }

  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
