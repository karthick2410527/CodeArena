import type { BillingOrder } from "../api/types";

/** What Razorpay Checkout hands back on success, to be verified by the server. */
export interface CheckoutSuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open(): void;
  on(event: "payment.failed", cb: (r: { error?: { description?: string } }) => void): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

const SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";
let loading: Promise<void> | null = null;

/** Loads Checkout once, on first use, so pages that never pay never fetch it. */
export function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error("Couldn't load Razorpay Checkout. Check your connection and try again."));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Opens Checkout for a server-created order. Resolves with the signed result
 * when the payment succeeds, or null if the buyer closes the window
 * without trying; rejects if they close it after a failed attempt.
 */
export async function payWithCheckout(order: BillingOrder): Promise<CheckoutSuccess | null> {
  await loadCheckout();
  const Razorpay = window.Razorpay;
  if (!Razorpay) throw new Error("Razorpay Checkout is unavailable.");
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--c-accent").trim().split(/\s+/).map(Number);
  const color = accent.length === 3 ? `#${accent.map((n) => n.toString(16).padStart(2, "0")).join("")}` : undefined;
  return new Promise((resolve, reject) => {
    // A failed attempt keeps Checkout open so the buyer can retry with another
    // method; only closing it ends the purchase, reporting the last failure.
    let failure: string | null = null;
    const rzp = new Razorpay({
      key: order.key_id ?? undefined,
      order_id: order.order_id,
      amount: order.amount_paise,
      currency: order.currency,
      name: "VoidRun",
      description: order.plan_name,
      prefill: { name: order.name, email: order.email ?? undefined },
      notes: { plan: order.plan },
      theme: color ? { color } : undefined,
      handler: (r: CheckoutSuccess) => resolve(r),
      modal: { ondismiss: () => (failure ? reject(new Error(failure)) : resolve(null)) },
    });
    rzp.on("payment.failed", (r) => {
      failure = r.error?.description ?? "The payment failed.";
    });
    rzp.open();
  });
}

/** ₹499, ₹4,999. */
export function formatRupees(paise: number): string {
  const r = paise / 100;
  return `₹${r.toLocaleString("en-IN", { minimumFractionDigits: r % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
