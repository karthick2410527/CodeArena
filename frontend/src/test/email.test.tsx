import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USER, apiError, authResponse, baseRoutes, json, list, mockApi, profile, renderApp, renderSignedIn } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const signedOut = {
  ...baseRoutes({ anonymous: true }),
  "GET /problems": () => json(list([])),
  "GET /tags": () => json([]),
  "GET /auth/email": () => json({ enabled: true }),
  "POST /auth/email/code": () => new Response(null, { status: 202 }),
};

describe("signing in with an emailed code", () => {
  it("asks for the address, then signs in as soon as all six digits are typed", async () => {
    const api = mockApi({ ...signedOut, "POST /auth/email/login": () => json(authResponse()) });
    renderApp("/login");
    await userEvent.click(await screen.findByRole("tab", { name: /email me a code/i }));
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: /email me a code/i }));

    expect(await screen.findByRole("status")).toHaveTextContent("ada@example.com");
    expect(screen.getByRole("button", { name: /resend in \d+s/i })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("6-digit code"), "12 34 56");

    expect(await screen.findByRole("heading", { name: /^problems$/i })).toBeInTheDocument();
    expect(api.bodiesFor("POST /auth/email/code")).toEqual([{ email: "ada@example.com", purpose: "login" }]);
    expect(api.bodiesFor("POST /auth/email/login")).toEqual([{ email: "ada@example.com", code: "123456" }]);
  });

  it("shows the server's answer to a wrong code and lets you try again", async () => {
    mockApi({
      ...signedOut,
      "POST /auth/email/login": () => apiError(401, "UNAUTHORIZED", "that code is wrong or has expired; ask for a new one"),
    });
    renderApp("/login");
    await userEvent.click(await screen.findByRole("tab", { name: /email me a code/i }));
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: /email me a code/i }));
    await userEvent.type(await screen.findByLabelText("6-digit code"), "000000");
    expect(await screen.findByRole("alert")).toHaveTextContent(/wrong or has expired/);
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeEnabled();
  });

  it("hides the option when the server cannot send mail", async () => {
    mockApi({ ...signedOut, "GET /auth/email": () => json({ enabled: false }) });
    renderApp("/login");
    expect(await screen.findByRole("heading", { name: /welcome back/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("tab", { name: /email me a code/i })).not.toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /forgot password/i })).not.toBeInTheDocument();
  });
});

describe("forgot password", () => {
  it("emails a reset code, sets the new password and signs in", async () => {
    const api = mockApi({ ...signedOut, "POST /auth/password/reset": () => json(authResponse()) });
    renderApp("/login");
    await userEvent.type(await screen.findByLabelText("Email"), "ada@example.com");
    await userEvent.click(await screen.findByRole("link", { name: /forgot password/i }));

    expect(await screen.findByRole("heading", { name: /reset your password/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: /email me a reset code/i }));
    await userEvent.type(await screen.findByLabelText("6-digit code"), "654321");
    await userEvent.type(screen.getByLabelText(/new password/i), "a brand new one");
    await userEvent.type(screen.getByLabelText(/repeat it/i), "a brand new on");
    await userEvent.click(screen.getByRole("button", { name: /set password and sign in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/don’t match/);

    await userEvent.type(screen.getByLabelText(/repeat it/i), "e");
    await userEvent.click(screen.getByRole("button", { name: /set password and sign in/i }));
    expect(await screen.findByRole("heading", { name: /^problems$/i })).toBeInTheDocument();
    expect(api.bodiesFor("POST /auth/email/code")).toEqual([{ email: "ada@example.com", purpose: "reset" }]);
    expect(api.bodiesFor("POST /auth/password/reset")).toEqual([
      { email: "ada@example.com", code: "654321", password: "a brand new one" },
    ]);
  });
});

describe("editing your profile", () => {
  it("changes the username from your public profile and follows it to the new address", async () => {
    const api = mockApi({
      ...baseRoutes(),
      "GET /users/me": () => json(USER),
      "PATCH /users/me": () => json({ ...USER, username: "ada_l" }),
      "GET /profiles/ada_l": () => json(profile({ username: "ada_l" })),
    });
    renderSignedIn("/u/ada");
    await userEvent.click(await screen.findByRole("button", { name: /edit profile/i }));
    const dialog = await screen.findByRole("dialog", { name: /edit profile/i });
    expect(dialog).toBeInTheDocument();
    const username = screen.getByLabelText("Username");
    await userEvent.clear(username);
    await userEvent.type(username, "ada l");
    expect(username).toHaveValue("adal");
    await userEvent.clear(username);
    await userEvent.type(username, "ada_l");
    expect(screen.getByText(/your profile moves to \/u\/ada_l/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.bodiesFor("PATCH /users/me")).toEqual([{ username: "ada_l" }]);
    expect(await screen.findByText("@ada_l")).toBeInTheDocument();
  });

  it("offers no editing on somebody else's profile", async () => {
    mockApi({ ...baseRoutes(), "GET /profiles/bob": () => json(profile({ username: "bob" })) });
    renderSignedIn("/u/bob");
    expect(await screen.findByText("@bob")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit profile/i })).not.toBeInTheDocument();
  });
});
