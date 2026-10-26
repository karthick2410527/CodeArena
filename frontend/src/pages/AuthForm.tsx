import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { authApi } from "../api/endpoints";
import { ProviderIcon, Wordmark } from "../components/ui";

/** Full-screen sign-in layout: the form on the left, a brand panel on wide screens. */
export function FormShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <main id="main" className="flex flex-col px-5 py-6 sm:px-10">
        <Wordmark />
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12">
          <h1 className="text-3xl font-semibold text-ink sm:text-4xl">{title}</h1>
          <p className="mt-2 text-muted">{subtitle}</p>
          <div className="mt-8">{children}</div>
        </div>
      </main>

      <aside
        className="relative hidden overflow-hidden border-l border-line/60 lg:block"
        style={{ background: "radial-gradient(900px 500px at 70% 10%, rgb(var(--c-accent) / 0.22), transparent 65%), rgb(var(--c-surface))" }}
        aria-hidden="true"
      >
        <div className="hero-grid absolute inset-0" />
        <div className="relative flex h-full flex-col justify-center px-14">
          <p className="eyebrow">VoidRun</p>
          <p className="mt-4 max-w-md font-display text-4xl font-semibold leading-tight tracking-tight text-ink">
            Solve it. Race it. Replay every step.
          </p>
          <ul className="mt-8 space-y-3 text-muted">
            {[
              "C++17, Java 21 and JavaScript, judged in a sandbox",
              "Live contests with standings that move as verdicts land",
              "Step through a C++ run, forwards and backwards",
              "Write problems and host your own rounds",
            ].map((t) => (
              <li key={t} className="flex items-center gap-3">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-accent/15 text-accent">
                  <Check size={14} />
                </span>
                {t}
              </li>
            ))}
          </ul>
          <div className="mock mt-12 max-w-md">
            <div className="mock-bar">
              <i />
              <i />
              <i />
              <span className="ml-3 rounded-md bg-surface px-3 py-0.5 font-mono text-[0.6875rem] text-faint">main.cpp</span>
            </div>
            <pre className="px-5 py-4 font-mono text-[0.8125rem] leading-6 text-ink">
              <span className="text-accent">int</span> main() {"{"}
              {"\n"}  <span className="text-accent">long long</span> a, b;
              {"\n"}  cin {">>"} a {">>"} b;
              {"\n"}  cout {"<<"} a + b;
              {"\n"}
              {"}"}
            </pre>
          </div>
        </div>
      </aside>
    </div>
  );
}

/**
 * "Continue with Google / GitHub". Both are always shown; one the server has
 * no credentials for is disabled with a note, so an unconfigured server is
 * obvious instead of the option silently missing.
 */
export function ProviderButtons({ verb }: { verb: string }) {
  const { data } = useQuery({ queryKey: ["auth-providers"], queryFn: authApi.providers, staleTime: 5 * 60_000 });
  if (!data || data.length === 0) return null;
  const off = data.filter((p) => !p.enabled);
  return (
    <div className="space-y-3">
      {data.map((p) =>
        p.enabled && p.authorize_url ? (
          <a key={p.id} href={p.authorize_url} className="btn-outline w-full">
            <ProviderIcon provider={p.id} />
            {verb} with {p.name}
          </a>
        ) : (
          <button key={p.id} type="button" className="btn-outline w-full" disabled aria-describedby="providers-off">
            <ProviderIcon provider={p.id} />
            {verb} with {p.name}
          </button>
        ),
      )}
      {off.length > 0 && (
        <p id="providers-off" className="text-xs text-faint">
          {off.map((p) => p.name).join(" and ")} sign-in {off.length > 1 ? "aren’t" : "isn’t"} set up on this server
          yet.
        </p>
      )}
      <div className="flex items-center gap-3 py-2 text-xs uppercase tracking-[0.14em] text-faint">
        <span className="h-px flex-1 bg-line" />
        or with email
        <span className="h-px flex-1 bg-line" />
      </div>
    </div>
  );
}

export function Field({
  id,
  label,
  error,
  hint,
  ...input
}: { id: string; label: string; error?: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="mb-1.5 text-sm text-muted">
          {hint}
        </p>
      )}
      <input id={id} className="input" aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
      {error && (
        <p id={`${id}-err`} className="mt-1 text-xs text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-xl border border-bad/30 border-l-[3px] border-l-bad bg-bad/5 px-3.5 py-2.5 text-sm text-bad">
      {message}
    </div>
  );
}

/** Whether this server can email sign-in codes; false until known, so nothing flashes in. */
export function useEmailSignIn(): boolean {
  const { data } = useQuery({ queryKey: ["auth-email"], queryFn: authApi.emailSignIn, staleTime: 5 * 60_000 });
  return data?.enabled ?? false;
}

/** Seconds left before another code may be asked for; `start()` begins the wait. */
export function useCooldown(seconds = 60) {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= now) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until, now]);
  return {
    left: Math.max(0, Math.ceil((until - now) / 1000)),
    start: () => {
      const t = Date.now();
      setNow(t);
      setUntil(t + seconds * 1000);
    },
  };
}

/** The six-digit code box: digits only, filled from the SMS/mail suggestion where the browser offers one. */
export function CodeField({ value, onChange, onComplete }: { value: string; onChange: (v: string) => void; onComplete?: (v: string) => void }) {
  return (
    <div>
      <label htmlFor="code" className="label">
        6-digit code
      </label>
      <input
        id="code"
        className="input text-center font-mono text-2xl tracking-[0.5em]"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        placeholder="••••••"
        autoFocus
        value={value}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
          onChange(digits);
          if (digits.length === 6) onComplete?.(digits);
        }}
      />
    </div>
  );
}

/** On a local server mail never leaves the machine; say where it went. */
export function LocalMailHint() {
  if (typeof window === "undefined" || !["localhost", "127.0.0.1"].includes(window.location.hostname)) return null;
  return (
    <p className="rounded-xl border border-dashed border-line-strong bg-paper/60 px-3 py-2 text-xs text-muted">
      Running locally: the email lands in Mailpit at{" "}
      <a href="http://localhost:8025" target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
        localhost:8025
      </a>
      .
    </p>
  );
}
