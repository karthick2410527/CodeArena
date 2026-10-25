import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CreditCard, FlaskConical, Lock, Smartphone, X } from "lucide-react";
import type { BillingOrder } from "../api/types";
import { formatRupees } from "../lib/razorpay";
import { Logo } from "./ui";

/**
 * The checkout used while the server runs with test payments: it looks and
 * flows like a real payment sheet, but nothing is charged. Paying calls
 * {@code onPay}, which asks the server to mark the test order paid.
 */
export default function TestCheckout({
  order,
  onPay,
  onClose,
}: {
  order: BillingOrder;
  onPay: () => Promise<void>;
  onClose: () => void;
}) {
  const [method, setMethod] = useState<"upi" | "card">("upi");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const payRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    payRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const pay = async () => {
    setError(null);
    setBusy(true);
    try {
      await onPay();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The test payment failed.");
      setBusy(false);
    }
  };

  // On <body>, so no card's clipping or animation can trap the overlay.
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Test checkout">
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm animate-[vr-fade_200ms_ease-out]" onClick={() => !busy && onClose()} />
      <div className="animate-pop relative w-full max-w-sm overflow-hidden rounded-2xl border border-line bg-surface shadow-panel">
        <div className="flex items-center justify-center gap-1.5 bg-warn/15 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-warn">
          <FlaskConical size={12} aria-hidden="true" /> Test mode · no real money
        </div>
        <div className="flex items-start justify-between gap-3 border-b border-line/70 p-5">
          <div className="flex items-center gap-3">
            <Logo size={34} />
            <div>
              <p className="font-semibold text-ink">VoidRun</p>
              <p className="text-xs text-muted">{order.plan_name}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="grid h-8 w-8 place-items-center rounded-lg text-faint hover:bg-sunken hover:text-ink"
            aria-label="Close the checkout"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5">
          <p className="text-xs text-faint">Amount</p>
          <p className="font-display text-3xl font-semibold tracking-tight text-ink">{formatRupees(order.amount_paise)}</p>

          <div className="mt-5 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Payment method">
            {(
              [
                ["upi", "UPI", Smartphone],
                ["card", "Card", CreditCard],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={method === id}
                onClick={() => setMethod(id)}
                className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                  method === id ? "border-accent bg-accent/[0.08] text-ink" : "border-line text-muted hover:border-line-strong"
                }`}
              >
                <Icon size={15} aria-hidden="true" /> {label}
              </button>
            ))}
          </div>

          <div className="mt-3 rounded-xl border border-line/70 bg-paper/60 px-3.5 py-3 font-mono text-sm text-muted">
            {method === "upi" ? (
              <>
                <span className="text-xs text-faint">UPI ID</span>
                <div className="text-ink">success@test</div>
              </>
            ) : (
              <>
                <span className="text-xs text-faint">Card</span>
                <div className="text-ink">4111 1111 1111 1111 · 12/30 · 123</div>
              </>
            )}
          </div>

          {error && (
            <p role="alert" className="mt-3 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">
              {error}
            </p>
          )}

          <button ref={payRef} type="button" className="btn btn-primary mt-5 w-full min-h-[48px] text-base" onClick={pay} disabled={busy}>
            {busy ? "Processing…" : `Pay ${formatRupees(order.amount_paise)}`}
          </button>
          <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-xs text-faint">
            <Lock size={11} aria-hidden="true" /> A test payment: your plan starts, nothing is charged.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
