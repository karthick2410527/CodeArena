import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { Notice, Wordmark } from "../components/ui";
import { Spinner } from "../components/Feedback";

/** What each `?error=` from the API's provider redirect means, in words a person can act on. */
export const OAUTH_ERRORS: Record<string, string> = {
  email_in_use:
    "An account with this email already exists. Sign in with your password, then connect this provider from your profile.",
  identity_in_use: "That account is already connected to another VoidRun user.",
  provider_conflict: "Your account already has a different account from this provider connected.",
  link_expired: "That connect request expired or was started in another browser. Please try again.",
  access_denied: "Sign-in was cancelled.",
  provider_error: "The provider could not sign you in. Please try again.",
};

const PROVIDER_NAMES: Record<string, string> = { google: "Google", github: "GitHub" };

/**
 * Where the API sends the browser after Google or GitHub. A `code` is traded
 * for a session exactly once (the API refuses a second use, and the browser
 * cookie must match); `linked` confirms a provider was connected.
 */
export default function AuthCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { completeOAuth, refreshUser, status } = useAuth();
  const [failure, setFailure] = useState<string | null>(null);
  // Effects run twice in development (StrictMode); the code must be sent once.
  const sent = useRef(false);

  const code = params.get("code");
  const linked = params.get("linked");
  const error = params.get("error");

  useEffect(() => {
    if (sent.current || error) return;
    if (code) {
      sent.current = true;
      completeOAuth(code)
        .then(() => navigate("/problems", { replace: true }))
        .catch(() => setFailure("This sign-in link has expired. Please sign in again."));
    } else if (linked && status === "authenticated") {
      sent.current = true;
      refreshUser()
        .catch(() => undefined)
        .finally(() => navigate(`/profile?linked=${encodeURIComponent(linked)}`, { replace: true }));
    } else if (!linked) {
      setFailure("Nothing to finish here.");
    }
  }, [code, linked, error, status, completeOAuth, refreshUser, navigate]);

  const message = error ? OAUTH_ERRORS[error] ?? OAUTH_ERRORS.provider_error : failure;
  const provider = PROVIDER_NAMES[params.get("provider") ?? ""];

  return (
    <div className="flex min-h-screen flex-col px-5 py-6 sm:px-10">
      <Wordmark />
      <main id="main" className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center">
        {message ? (
          <div className="space-y-6">
            <h1 className="text-3xl font-semibold text-ink">{provider ? `${provider} sign-in` : "Sign-in"} didn’t finish</h1>
            <Notice tone="bad">{message}</Notice>
            <div className="flex gap-3">
              <Link to="/login" className="btn-primary">
                Back to sign in
              </Link>
              {status === "authenticated" && (
                <Link to="/profile" className="btn-outline">
                  Your profile
                </Link>
              )}
            </div>
          </div>
        ) : (
          <Spinner label="Signing you in…" />
        )}
      </main>
    </div>
  );
}
