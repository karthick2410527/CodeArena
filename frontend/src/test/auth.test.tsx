import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, authResponse, json, list, mockApi, renderApp, USER } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const catalog = {
  "GET /problems": () => json(list([])),
  "GET /tags": () => json([]),
};

describe("protected routes", () => {
  it("redirects anonymous visitors from /profile to the login page", async () => {
    mockApi({ ...catalog });
    renderApp("/profile");
    expect(await screen.findByRole("heading", { name: /welcome back/i })).toBeInTheDocument();
    expect(screen.queryByText(/your account/i)).not.toBeInTheDocument();
  });

  it("restores the session after a reload using the stored refresh token", async () => {
    const api = mockApi({
      ...catalog,
      "POST /auth/refresh": () => json(authResponse({ access_token: "access-2", refresh_token: "refresh-2" })),
      "GET /users/me": (_u, init) =>
        (init?.headers as Record<string, string>)?.Authorization === "Bearer access-2"
          ? json(USER)
          : apiError(401, "UNAUTHORIZED", "invalid or expired token"),
    });
    renderApp("/profile", { refreshToken: "refresh-1" });

    expect(await screen.findByRole("heading", { name: /your account/i })).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    // refresh token was rotated and persisted
    expect(localStorage.getItem("voidrun.refresh_token")).toBe("refresh-2");
    expect(api.calls.filter((c) => c.key === "POST /auth/refresh")).toHaveLength(1);
  });

  it("sends the user to login when the stored refresh token is rejected", async () => {
    mockApi({
      ...catalog,
      "POST /auth/refresh": () => apiError(401, "UNAUTHORIZED", "invalid or expired refresh token"),
    });
    renderApp("/profile", { refreshToken: "stale" });
    expect(await screen.findByRole("heading", { name: /welcome back/i })).toBeInTheDocument();
    expect(localStorage.getItem("voidrun.refresh_token")).toBeNull();
  });
});

describe("login", () => {
  it("logs in, stores the session and lands on the problems page", async () => {
    mockApi({
      ...catalog,
      "POST /auth/login": (_u, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ email: "ada@example.com", password: "supersecret1" });
        return json(authResponse());
      },
    });
    renderApp("/login");
    await userEvent.type(await screen.findByLabelText(/email/i), "ada@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "supersecret1");
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(await screen.findByRole("heading", { name: /^problems$/i })).toBeInTheDocument();
    expect(localStorage.getItem("voidrun.refresh_token")).toBe("refresh-1");
    expect(screen.getByRole("button", { name: "Account menu" })).toHaveTextContent("ada");
  });

  it("shows the server's error for bad credentials", async () => {
    mockApi({
      ...catalog,
      "POST /auth/login": () => apiError(401, "UNAUTHORIZED", "invalid email or password"),
    });
    renderApp("/login");
    await userEvent.type(await screen.findByLabelText(/email/i), "ada@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("invalid email or password");
    expect(localStorage.getItem("voidrun.refresh_token")).toBeNull();
  });
});

describe("register", () => {
  it("validates input client-side before calling the API", async () => {
    const api = mockApi({ ...catalog });
    renderApp("/register");
    await userEvent.type(await screen.findByLabelText(/username/i), "ab");
    await userEvent.type(screen.getByLabelText(/email/i), "nope");
    await userEvent.type(screen.getByLabelText(/password/i), "short");
    await userEvent.click(screen.getByRole("button", { name: /^create account$/i }));

    expect(await screen.findByText(/3-32 characters/i)).toBeInTheDocument();
    expect(screen.getByText(/tell us what to call you/i)).toBeInTheDocument();
    expect(screen.getByText(/valid email/i)).toBeInTheDocument();
    expect(screen.getByText(/8-128 characters/i)).toBeInTheDocument();
    expect(api.calls.some((c) => c.key === "POST /auth/register")).toBe(false);
  });

  it("registers and signs the user in; shows conflicts from the API", async () => {
    let conflict = true;
    const api = mockApi({
      ...catalog,
      "POST /auth/register": () =>
        conflict ? apiError(409, "CONFLICT", "username or email is already in use") : json(authResponse(), 201),
    });
    renderApp("/register");
    await userEvent.type(await screen.findByLabelText("Your name"), "Ada Lovelace");
    await userEvent.type(screen.getByLabelText(/username/i), "ada");
    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "supersecret1");
    await userEvent.click(screen.getByRole("button", { name: /^create account$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already in use/i);

    conflict = false;
    await userEvent.click(screen.getByRole("button", { name: /^create account$/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /^problems$/i })).toBeInTheDocument());
    expect(api.bodiesFor("POST /auth/register").at(-1)).toMatchObject({ username: "ada", display_name: "Ada Lovelace" });
  });
});

describe("logout", () => {
  it("revokes the refresh token and clears the session", async () => {
    const api = mockApi({
      ...catalog,
      "POST /auth/refresh": () => json(authResponse()),
      "POST /auth/logout": () => new Response(null, { status: 204 }),
    });
    renderApp("/problems", { refreshToken: "refresh-0" });
    await userEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /sign out/i }));

    expect(await screen.findByRole("link", { name: /^sign in$/i })).toBeInTheDocument();
    expect(localStorage.getItem("voidrun.refresh_token")).toBeNull();
    await waitFor(() => expect(api.calls.some((c) => c.key === "POST /auth/logout")).toBe(true));
  });
});
