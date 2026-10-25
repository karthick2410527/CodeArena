import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { Field, FormError, FormShell, ProviderButtons } from "./AuthForm";

type Errors = Partial<Record<"name" | "username" | "email" | "password", string>>;

function validate(name: string, username: string, email: string, password: string): Errors {
  const e: Errors = {};
  if (!name) e.name = "Tell us what to call you";
  else if (name.length > 60) e.name = "At most 60 characters";
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) e.username = "3-32 characters: letters, digits, _ or -";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email = "Enter a valid email address";
  if (password.length < 8 || password.length > 128) e.password = "Use 8-128 characters";
  return e;
}

export default function RegisterPage() {
  const { status, register } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
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
    const found = validate(name.trim(), username.trim(), email.trim(), password);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      await register(username.trim(), email.trim(), password, name.trim());
      navigate("/problems", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormShell title="Create your account" subtitle="Start solving problems in minutes.">
      <ProviderButtons verb="Sign up" />
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field id="name" label="Your name" hint="Shown on your profile and in contest standings." autoComplete="name" value={name} error={errors.name} onChange={(e) => setName(e.target.value)} />
        <Field id="username" label="Username" hint="3–32 letters, digits, _ or -." autoComplete="username" value={username} error={errors.username} onChange={(e) => setUsername(e.target.value)} />
        <Field id="email" label="Email" type="email" autoComplete="email" value={email} error={errors.email} onChange={(e) => setEmail(e.target.value)} />
        <Field id="password" label="Password" hint="At least 8 characters. A short phrase works well." type="password" autoComplete="new-password" value={password} error={errors.password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" className="btn-primary min-h-[48px] w-full text-base" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>
      <p className="mt-5 text-center text-sm text-muted">
        Already registered?{" "}
        <Link to="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </FormShell>
  );
}
