import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Mail } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { authApi } from "../api/endpoints";
import { CodeField, Field, FormError, FormShell, LocalMailHint, useCooldown } from "./AuthForm";

/** "Forgot password": a code by email, then a new password, and you are signed in. */
export default function ForgotPasswordPage() {
  const { status, resetPassword } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState((location.state as { email?: string } | null)?.email ?? "");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cooldown = useCooldown();

  if (status === "authenticated" && !busy) return <Navigate to="/problems" replace />;

  const message = (err: unknown) => (err instanceof ApiError ? err.message : "Could not reach the server. Please try again.");

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    setError(null);
    const to = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      setError("Enter the email address of your account.");
      return;
    }
    setBusy(true);
    try {
      await authApi.requestCode(to, "reset");
      setSentTo(to);
      cooldown.start();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: FormEvent) => {
    e.preventDefault();
    if (!sentTo) return;
    setError(null);
    if (code.length !== 6) return setError("Enter the 6-digit code from the email.");
    if (password.length < 8) return setError("Choose a password of at least 8 characters.");
    if (password !== confirm) return setError("The two passwords don’t match.");
    setBusy(true);
    try {
      await resetPassword(sentTo, code, password);
      navigate("/problems", { replace: true });
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  return (
    <FormShell title="Reset your password" subtitle={sentTo ? "Enter the code and choose a new password." : "We’ll email you a code to set a new one."}>
      {!sentTo ? (
        <form onSubmit={send} className="space-y-4" noValidate>
          <FormError message={error} />
          <Field id="email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="submit" className="btn-primary min-h-[48px] w-full text-base" disabled={busy}>
            <Mail size={16} aria-hidden="true" /> {busy ? "Sending…" : "Email me a reset code"}
          </button>
        </form>
      ) : (
        <form onSubmit={reset} className="space-y-4" noValidate>
          <div className="rounded-xl border border-accent/25 bg-accent/5 px-3.5 py-3 text-sm text-ink" role="status">
            If an account uses <strong className="font-semibold">{sentTo}</strong>, a code is on its way. It works once, for
            10 minutes.
          </div>
          <FormError message={error} />
          <CodeField value={code} onChange={setCode} />
          <Field id="new-password" label="New password" type="password" autoComplete="new-password" hint="At least 8 characters." value={password} onChange={(e) => setPassword(e.target.value)} />
          <Field id="confirm-password" label="Repeat it" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <button type="submit" className="btn-primary min-h-[48px] w-full text-base" disabled={busy}>
            {busy ? "Saving…" : "Set password and sign in"}
          </button>
          <p className="text-xs text-faint">Other devices signed in to your account will be signed out.</p>
          <div className="flex items-center justify-between text-sm">
            <button type="button" className="text-muted hover:text-ink" onClick={() => setSentTo(null)}>
              Use a different email
            </button>
            <button type="button" className="font-medium text-accent hover:underline disabled:text-faint disabled:no-underline" disabled={cooldown.left > 0 || busy} onClick={() => void send()}>
              {cooldown.left > 0 ? `Resend in ${cooldown.left}s` : "Resend code"}
            </button>
          </div>
          <LocalMailHint />
        </form>
      )}
      <p className="mt-5 text-center text-sm text-muted">
        Remembered it?{" "}
        <Link to="/login" className="font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      </p>
    </FormShell>
  );
}
