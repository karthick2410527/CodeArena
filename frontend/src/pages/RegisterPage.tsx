import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { Field, FormError, FormShell } from "./AuthForm";

type Errors = Partial<Record<"username" | "email" | "password", string>>;

function validate(username: string, email: string, password: string): Errors {
  const e: Errors = {};
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) e.username = "3-32 characters: letters, digits, _ or -";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email = "Enter a valid email address";
  if (password.length < 8 || password.length > 128) e.password = "Use 8-128 characters";
  return e;
}

export default function RegisterPage() {
  const { status, register } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === "authenticated") return <Navigate to="/problems" replace />;

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    const found = validate(username.trim(), email.trim(), password);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      await register(username.trim(), email.trim(), password);
      navigate("/problems", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormShell title="Create your account" subtitle="Start solving problems in minutes.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field id="username" label="Username" autoComplete="username" value={username} error={errors.username} onChange={(e) => setUsername(e.target.value)} />
        <Field id="email" label="Email" type="email" autoComplete="email" value={email} error={errors.email} onChange={(e) => setEmail(e.target.value)} />
        <Field id="password" label="Password" type="password" autoComplete="new-password" value={password} error={errors.password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" className="btn btn-primary w-full" disabled={busy}>
          {busy ? "Creating account…" : "Sign up"}
        </button>
      </form>
      <p className="mt-5 text-center text-sm text-slate-400">
        Already registered?{" "}
        <Link to="/login" className="text-indigo-400 hover:underline">
          Log in
        </Link>
      </p>
    </FormShell>
  );
}
