import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { KeyRound, Mail } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { authApi } from "../api/endpoints";
import { CodeField, Field, FormError, FormShell, LocalMailHint, ProviderButtons, useCooldown, useEmailSignIn } from "./AuthForm";

type Mode = "password" | "code";

export default function LoginPage() {
  const { status } = useAuth();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/problems";
  const emailOn = useEmailSignIn();
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");

  if (status === "authenticated") return <Navigate to={from} replace />;
  const current: Mode = emailOn ? mode : "password";

  return (
    <FormShell title="Welcome back" subtitle="Sign in to keep solving.">
      <ProviderButtons verb="Continue" />
      {emailOn && (
        <div className="mb-5 grid grid-cols-2 gap-0.5 rounded-xl border border-line bg-paper/60 p-0.5" role="tablist" aria-label="Sign in with">
          {(
            [
              ["password", "Password", KeyRound],
              ["code", "Email me a code", Mail],
            ] as const
          ).map(([m, label, Icon]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={current === m}
              onClick={() => setMode(m)}
              className={`flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition ${
                current === m ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              <Icon size={14} aria-hidden="true" /> {label}
            </button>
          ))}
        </div>
      )}
      {current === "password" ? (
        <PasswordSignIn email={email} setEmail={setEmail} from={from} emailOn={emailOn} />
      ) : (
        <CodeSignIn email={email} setEmail={setEmail} from={from} />
      )}
      <p className="mt-5 text-center text-sm text-muted">
        New here?{" "}
        <Link to="/register" className="font-medium text-accent hover:underline">
          Create an account
        </Link>
      </p>
    </FormShell>
  );
}

function message(err: unknown) {
  return err instanceof ApiError ? err.message : "Could not reach the server. Please try again.";
}

function PasswordSignIn({ email, setEmail, from, emailOn }: { email: string; setEmail: (v: string) => void; from: string; emailOn: boolean }) {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setBusy(true);
    try {
      await login(email.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <FormError message={error} />
      <Field id="email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <div>
        <Field id="password" label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {emailOn && (
          <p className="mt-1.5 text-right text-sm">
            <Link to="/forgot-password" state={{ email }} className="text-accent hover:underline">
              Forgot password?
            </Link>
          </p>
        )}
      </div>
      <button type="submit" className="btn-primary min-h-[48px] w-full text-base" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

/** Two steps: the address, then the code that was mailed to it. */
function CodeSignIn({ email, setEmail, from }: { email: string; setEmail: (v: string) => void; from: string }) {
  const { loginWithCode } = useAuth();
  const navigate = useNavigate();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cooldown = useCooldown();

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
      await authApi.requestCode(to, "login");
      setSentTo(to);
      setCode("");
      cooldown.start();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value = code) => {
    if (!sentTo) return;
    setError(null);
    if (value.length !== 6) {
      setError("Enter all 6 digits.");
      return;
    }
    setBusy(true);
    try {
      await loginWithCode(sentTo, value);
      navigate(from, { replace: true });
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  if (!sentTo) {
    return (
      <form onSubmit={send} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field id="code-email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} hint="We’ll email you a 6-digit code. No password needed." />
        <button type="submit" className="btn-primary min-h-[48px] w-full text-base" disabled={busy}>
          <Mail size={16} aria-hidden="true" /> {busy ? "Sending…" : "Email me a code"}
        </button>
      </form>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void verify();
      }}
      className="space-y-4"
      noValidate
    >
      <div className="rounded-xl border border-accent/25 bg-accent/5 px-3.5 py-3 text-sm text-ink" role="status">
        If an account uses <strong className="font-semibold">{sentTo}</strong>, a code is on its way. It works once, for 10
        minutes.
      </div>
      <FormError message={error} />
      <CodeField value={code} onChange={setCode} onComplete={(v) => void verify(v)} />
      <button type="submit" className="btn-primary min-h-[48px] w-full text-base" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
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
  );
}
