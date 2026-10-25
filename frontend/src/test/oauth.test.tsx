import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authResponse,
  baseRoutes,
  json,
  list,
  mockApi,
  renderApp,
  renderSignedIn,
  stats,
  USER,
} from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const catalog = {
  "GET /problems": () => json(list([])),
  "GET /tags": () => json([]),
};

const GITHUB = { id: "github", name: "GitHub", enabled: true, authorize_url: "/oauth2/authorization/github" };
const GOOGLE = { id: "google", name: "Google", enabled: true, authorize_url: "/oauth2/authorization/google" };

describe("provider sign-in buttons", () => {
  it("offers each configured provider as a plain link to its redirect", async () => {
    mockApi({ ...baseRoutes({ anonymous: true }), "GET /auth/providers": () => json([GOOGLE, GITHUB]) });
    renderApp("/login");
    expect(await screen.findByRole("link", { name: /continue with github/i })).toHaveAttribute(
      "href",
      "/oauth2/authorization/github",
    );
    expect(screen.getByRole("link", { name: /continue with google/i })).toHaveAttribute(
      "href",
      "/oauth2/authorization/google",
    );
  });

  it("still shows both buttons when the server has no credentials, disabled with a note", async () => {
    mockApi({ ...baseRoutes({ anonymous: true }) });
    renderApp("/register");
    expect(await screen.findByRole("button", { name: /^create account$/i })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /with google/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /with github/i })).toBeDisabled();
    expect(screen.getByText(/google and github sign-in aren’t set up on this server yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /with github/i })).not.toBeInTheDocument();
  });

  it("enables only the providers the server can use", async () => {
    mockApi({
      ...baseRoutes({ anonymous: true }),
      "GET /auth/providers": () => json([{ ...GOOGLE, enabled: false, authorize_url: null }, GITHUB]),
    });
    renderApp("/login");
    expect(await screen.findByRole("link", { name: /continue with github/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeDisabled();
    expect(screen.getByText(/^google sign-in isn’t set up/i)).toBeInTheDocument();
  });
});

describe("the provider callback", () => {
  it("trades the one-time code for a session exactly once", async () => {
    const api = mockApi({
      ...baseRoutes({ anonymous: true }),
      ...catalog,
      "POST /auth/oauth/exchange": () => json(authResponse({ refresh_token: "from-github" })),
    });
    renderApp("/auth/callback?code=one-time-code");

    expect(await screen.findByRole("heading", { name: /^problems$/i })).toBeInTheDocument();
    const exchanges = api.calls.filter((c) => c.key === "POST /auth/oauth/exchange");
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].body).toEqual({ code: "one-time-code" });
    expect(localStorage.getItem("voidrun.refresh_token")).toBe("from-github");
  });

  it("explains why a sign-in was refused, in words a person can act on", async () => {
    mockApi({ ...baseRoutes({ anonymous: true }) });
    renderApp("/auth/callback?error=email_in_use&provider=google");
    expect(await screen.findByRole("heading", { name: /google sign-in didn’t finish/i })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/sign in with your password, then connect/i);
    expect(screen.getByRole("link", { name: /back to sign in/i })).toHaveAttribute("href", "/login");
  });

  it("reports an expired code instead of spinning forever", async () => {
    mockApi({
      ...baseRoutes({ anonymous: true }),
      "POST /auth/oauth/exchange": () =>
        new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "expired" } }), { status: 401 }),
    });
    renderApp("/auth/callback?code=stale");
    expect(await screen.findByRole("alert")).toHaveTextContent(/expired/i);
  });
});

describe("sign-in methods on the profile", () => {
  const profileRoutes = (user: typeof USER) => ({
    ...baseRoutes({ user }),
    "GET /users/me": () => json(user),
    "GET /users/me/stats": () => json(stats()),
    "GET /auth/providers": () => json([GOOGLE, GITHUB]),
    "GET /users/me/identities": () =>
      json([{ provider: "github", login: "octo", email: null, created_at: "2026-01-02T03:04:05Z", last_used_at: "2026-01-02T03:04:05Z" }]),
  });

  it("will not let the only way to sign in be disconnected", async () => {
    mockApi(profileRoutes({ ...USER, has_password: false }));
    renderSignedIn("/profile");
    const section = (await screen.findByRole("heading", { name: /sign-in methods/i })).parentElement!;
    expect(within(section).getByText("octo")).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: /disconnect/i })).toBeDisabled();
    expect(within(section).getByRole("button", { name: /^connect$/i })).toBeEnabled();
  });

  it("disconnects a provider when a password remains", async () => {
    const api = mockApi({
      ...profileRoutes(USER),
      "DELETE /users/me/identities/github": () => new Response(null, { status: 204 }),
    });
    renderSignedIn("/profile");
    await userEvent.click(await screen.findByRole("button", { name: /disconnect/i }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.key === "DELETE /users/me/identities/github")).toBe(true),
    );
  });
});
