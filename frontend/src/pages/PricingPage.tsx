import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Check, CreditCard, Gauge, Lock, Radio, ShieldCheck, Sparkles, Trophy, Users, Zap } from "lucide-react";
import { billingApi } from "../api/endpoints";
import type { BillingMe, BillingOrder, BillingPlan } from "../api/types";
import TestCheckout from "../components/TestCheckout";
import { useViewer } from "../auth/AuthContext";
import { HostTabs, HubHero, SectionHead } from "../components/ContestHub";
import { formatWhen } from "../components/contest";
import { ErrorState, Spinner } from "../components/Feedback";
import { Notice } from "../components/ui";
import { formatRupees, payWithCheckout } from "../lib/razorpay";

const INCLUDED: [typeof Zap, string, string][] = [
  [Zap, "Priority judging", "Your contestants' submissions go to a dedicated judge pool, ahead of practice traffic."],
  [Trophy, "Publish unlimited rounds", "Any scoring rule, up to 26 problems and 10 co-authors each."],
  [Radio, "Live standings", "The scoreboard updates the moment a verdict lands, for everyone watching."],
  [Users, "Registration and editorials", "People register on your contest page; you release the editorial at the end."],
];

/**
 * Host plans. Practising and competing stay free; publishing a contest needs
 * an active plan, because a live round reserves judge capacity for it.
 */
export default function PricingPage() {
  const { ready, signedIn } = useViewer();
  const plans = useQuery({ queryKey: ["billing-plans"], queryFn: () => billingApi.plans() });
  const me = useQuery({ queryKey: ["billing-me"], queryFn: () => billingApi.me(), enabled: ready && signedIn });

  if (plans.isPending) return <Spinner label="Loading plans…" />;
  if (plans.isError) return <ErrorState title="Couldn't load the plans" message={plans.error.message} onRetry={() => plans.refetch()} />;

  const p = plans.data;
  const monthly = p.plans.find((x) => x.period_days <= 31);
  const status = me.data;
  const active = status?.hosting_until && new Date(status.hosting_until).getTime() > Date.now();

  return (
    <div>
      <HostTabs />
      <HubHero
        eyebrow="Host plans"
        title={
          <>
            Host rounds people <span className="text-accent-shine">remember.</span>
          </>
        }
        description="Practising and competing are free, always. A Host plan lets you publish contests, and your contestants' submissions get their own priority judge pool."
        aside={signedIn && status ? <StatusCard me={status} /> : undefined}
      />

      {!p.required ? (
        <div className="mb-8">
          <Notice title="Hosting is free on this server">
            Plans aren't required here, so anyone can host. Set HOST_PLAN_REQUIRED=true to require them.
          </Notice>
        </div>
      ) : p.mode === "test" ? (
        <div className="mb-8">
          <Notice tone="warn" title="Test payments: no real money">
            Plans here are bought with a test checkout and start straight away, and nothing is charged. Real payments
            use Razorpay once its keys are added (see docs/DEPLOY.md).
          </Notice>
        </div>
      ) : (
        !p.enabled && (
          <div className="mb-8">
            <Notice tone="warn" title="Payments aren't switched on yet">
              Plans can be bought once this site's Razorpay keys are set (RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET).
              Until then only administrators can host.
            </Notice>
          </div>
        )
      )}

      <section aria-label="Plans" className="mx-auto grid max-w-4xl gap-5 md:grid-cols-2">
        {p.plans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            featured={plan.period_days > 31}
            saving={monthly && plan.period_days > 31 ? saving(monthly, plan) : null}
            enabled={p.enabled && p.required}
            required={p.required}
            signedIn={signedIn}
            renewing={Boolean(active && status?.plan)}
          />
        ))}
      </section>

      <p className="mx-auto mt-4 flex max-w-4xl items-center justify-center gap-2 text-center text-xs text-faint">
        <Lock size={12} aria-hidden="true" />
        {p.mode === "test"
          ? "Test mode: the checkout is a stand-in and no money moves."
          : "Payments are handled by Razorpay: UPI, cards, netbanking and wallets. VoidRun never sees your card details."}
      </p>

      <section className="reveal mt-16" aria-labelledby="included-h">
        <SectionHead id="included-h" icon={Sparkles} title="Every Host plan includes" />
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {INCLUDED.map(([Icon, title, body]) => (
            <li key={title} className="card p-5">
              <span className="icon-tile">
                <Icon size={18} aria-hidden="true" />
              </span>
              <p className="mt-4 font-semibold text-ink">{title}</p>
              <p className="mt-1 text-sm text-muted">{body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="reveal mt-16 grid gap-6 lg:grid-cols-2" aria-label="Questions">
        <div className="card p-6">
          <p className="flex items-center gap-2 font-display text-lg font-semibold text-ink">
            <Gauge size={18} className="text-accent" aria-hidden="true" /> Why hosting is paid
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            A live round sends a burst of submissions all at once, and contestants are racing a clock. Each published contest
            is judged on its own worker pool, and its jobs leave the queue before practice work, so a busy evening never
            slows your round down. The plan pays for keeping that capacity free.
          </p>
        </div>
        <div className="card p-6">
          <p className="flex items-center gap-2 font-display text-lg font-semibold text-ink">
            <ShieldCheck size={18} className="text-accent" aria-hidden="true" /> What stays free
          </p>
          <ul className="mt-3 space-y-2 text-sm text-muted">
            {[
              "Solving problems, running code and step-by-step debugging",
              "Registering for and competing in any contest",
              "Writing problems and setting up contest drafts",
              "Profiles, standings and editorials",
            ].map((t) => (
              <li key={t} className="flex gap-2">
                <Check size={15} className="mt-0.5 shrink-0 text-good" aria-hidden="true" /> {t}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {status && status.payments.length > 0 && <History me={status} />}
    </div>
  );
}

/** Months a plan covers: 12 for a year. */
function months(plan: BillingPlan): number {
  return Math.max(1, Math.round(plan.period_days / 30.4));
}

/** "Save 17%" against paying monthly for as long. */
function saving(monthly: BillingPlan, plan: BillingPlan): string | null {
  const pct = Math.round((1 - plan.amount_paise / (monthly.amount_paise * months(plan))) * 100);
  return pct >= 5 ? `Save ${pct}%` : null;
}

function StatusCard({ me }: { me: BillingMe }) {
  const until = me.hosting_until ? new Date(me.hosting_until) : null;
  const active = until !== null && until.getTime() > Date.now();
  const days = until ? Math.ceil((until.getTime() - Date.now()) / 86_400_000) : 0;
  return (
    <div className="rounded-2xl border border-line/70 bg-surface/80 p-5 backdrop-blur">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-faint">Your plan</p>
      {active ? (
        <>
          <p className="mt-2 flex items-center gap-2 font-display text-lg font-semibold text-ink">
            <BadgeCheck size={18} className="text-good" aria-hidden="true" /> Hosting is on
          </p>
          <p className="mt-1 text-sm text-muted">
            Until {formatWhen(until!.toISOString())} · {days} day{days === 1 ? "" : "s"} left
          </p>
          <div className="progress-track mt-3">
            <div className="progress-fill" style={{ width: `${Math.min(100, (days / 365) * 100)}%` }} />
          </div>
          <Link to="/contests/new" className="btn btn-primary mt-4 w-full">
            Host a contest
          </Link>
        </>
      ) : me.can_host ? (
        <>
          <p className="mt-2 font-display text-lg font-semibold text-ink">You can host</p>
          <p className="mt-1 text-sm text-muted">{me.required ? "Administrators host without a plan." : "Hosting is free on this server."}</p>
        </>
      ) : (
        <>
          <p className="mt-2 font-display text-lg font-semibold text-ink">{until ? "Your plan has ended" : "No plan yet"}</p>
          <p className="mt-1 text-sm text-muted">
            {until ? `It ran until ${formatWhen(until.toISOString())}. Renew to publish again.` : "Pick a plan below to publish your first contest."}
          </p>
        </>
      )}
    </div>
  );
}

function PlanCard({
  plan,
  featured,
  saving,
  enabled,
  required,
  signedIn,
  renewing,
}: {
  plan: BillingPlan;
  featured: boolean;
  saving: string | null;
  enabled: boolean;
  required: boolean;
  signedIn: boolean;
  renewing: boolean;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [testOrder, setTestOrder] = useState<BillingOrder | null>(null);

  const payTest = async () => {
    const me = await billingApi.testPay(testOrder!.order_id);
    qc.setQueryData(["billing-me"], me);
    setTestOrder(null);
    setDone(true);
  };
  const perMonth = Math.round(plan.amount_paise / months(plan) / 100) * 100;

  const buy = async () => {
    if (!signedIn) {
      navigate("/login", { state: { from: "/pricing" } });
      return;
    }
    setError(null);
    setDone(false);
    setBusy(true);
    try {
      const order = await billingApi.createOrder(plan.id);
      if (order.mode === "test") {
        // The test checkout takes over from here; it reports back through payTest.
        setTestOrder(order);
        return;
      }
      const result = await payWithCheckout(order);
      if (result) {
        const me = await billingApi.verify(result);
        qc.setQueryData(["billing-me"], me);
        setDone(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The payment didn't go through.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      className={`relative flex flex-col overflow-hidden rounded-[1.5rem] border p-7 shadow-panel ${
        featured ? "border-accent/50 bg-surface" : "border-line/80 bg-surface"
      }`}
      style={featured ? { boxShadow: "0 0 0 1px rgb(var(--c-accent) / 0.25), 0 30px 70px -35px rgb(var(--c-accent) / 0.55)" } : undefined}
      aria-label={plan.name}
    >
      {testOrder && <TestCheckout order={testOrder} onPay={payTest} onClose={() => setTestOrder(null)} />}
      {featured && <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-accent/20 blur-3xl" aria-hidden="true" />}
      <div className="relative flex items-center justify-between gap-2">
        <h2 className="font-display text-xl font-semibold text-ink">{plan.name}</h2>
        {saving && <span className="rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-accent-ink">{saving}</span>}
      </div>
      <p className="relative mt-5 flex items-end gap-1.5">
        <span className="font-display text-5xl font-semibold tracking-tight text-ink">{formatRupees(plan.amount_paise)}</span>
        <span className="pb-1.5 text-sm text-muted">/ {plan.period_days > 31 ? "year" : "month"}</span>
      </p>
      <p className="relative mt-1 text-sm text-faint">
        {plan.period_days > 31 ? `${formatRupees(perMonth)} a month, billed once a year` : "Billed once, for 30 days"}
      </p>
      <ul className="relative mt-6 space-y-2.5 text-sm text-muted">
        {[
          `${plan.period_days} days of hosting`,
          "Priority judge pool for your contests",
          "Unlimited published contests",
          "Adds to your current plan if you renew early",
        ].map((t) => (
          <li key={t} className="flex gap-2">
            <Check size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" /> {t}
          </li>
        ))}
      </ul>
      <div className="relative mt-auto pt-7">
        {error && (
          <p role="alert" className="mb-3 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">
            {error}
          </p>
        )}
        {done && (
          <p role="status" className="mb-3 rounded-lg border border-good/30 bg-good/10 px-3 py-2 text-sm text-good">
            Payment received. Hosting is on.
          </p>
        )}
        <button
          type="button"
          className={`btn w-full min-h-[48px] text-base ${featured ? "btn-primary" : "btn-outline"}`}
          onClick={buy}
          disabled={busy || !enabled}
        >
          <CreditCard size={17} aria-hidden="true" />
          {!enabled ? (required ? "Coming soon" : "Not needed here") : busy ? "Opening checkout…" : !signedIn ? "Sign in to subscribe" : renewing ? "Extend my plan" : `Get ${plan.name}`}
        </button>
      </div>
    </article>
  );
}

function History({ me }: { me: BillingMe }) {
  return (
    <section className="reveal mt-16" aria-labelledby="history-h">
      <SectionHead id="history-h" icon={CreditCard} title="Payment history" count={me.payments.length} />
      <div className="card overflow-x-auto">
        <table className="data-table" aria-label="Payments">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Plan</th>
              <th scope="col">Amount</th>
              <th scope="col">Status</th>
              <th scope="col">Razorpay reference</th>
            </tr>
          </thead>
          <tbody>
            {me.payments.map((p) => (
              <tr key={p.id}>
                <td className="whitespace-nowrap text-muted">{formatWhen(p.paid_at ?? p.created_at)}</td>
                <td className="text-ink">{p.plan === "host-yearly" ? "Host Yearly" : p.plan === "host-monthly" ? "Host Monthly" : p.plan}</td>
                <td className="tabular text-ink">{formatRupees(p.amount_paise)}</td>
                <td>
                  <span className={`chip ${p.status === "PAID" ? "border-good/30 bg-good/10 text-good" : "border-bad/30 bg-bad/10 text-bad"}`}>
                    {p.status === "PAID" ? "Paid" : "Failed"}
                  </span>
                  {p.test && <span className="chip ml-1.5 border-warn/30 bg-warn/10 text-warn">Test</span>}
                </td>
                <td className="font-mono text-xs text-faint">{p.razorpay_payment_id ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
