import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContestDetail } from "../api/types";
import { baseRoutes, billingMe, billingPlans, json, mockApi, paginated, renderSignedIn } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.Razorpay;
});

/** Stands in for Razorpay Checkout: "pays" as soon as it is opened. */
function fakeCheckout(result: "pay" | "close" = "pay") {
  const opened: Record<string, unknown>[] = [];
  window.Razorpay = class {
    constructor(private options: Record<string, unknown>) {
      opened.push(options);
    }
    on() {}
    open() {
      if (result === "pay") {
        (this.options.handler as (r: unknown) => void)({
          razorpay_order_id: this.options.order_id,
          razorpay_payment_id: "pay_123",
          razorpay_signature: "sig",
        });
      } else {
        (this.options.modal as { ondismiss: () => void }).ondismiss();
      }
    }
  } as unknown as typeof window.Razorpay;
  return opened;
}

const order = {
  order_id: "order_1",
  mode: "razorpay" as const,
  amount_paise: 499900,
  currency: "INR",
  key_id: "rzp_test_key",
  plan: "host-yearly",
  plan_name: "Host Yearly",
  name: "Ada",
  email: "ada@example.com",
};

describe("host plans", () => {
  it("buys a plan through Razorpay Checkout and turns hosting on", async () => {
    const opened = fakeCheckout();
    const until = new Date(Date.now() + 365 * 86_400_000).toISOString();
    const api = mockApi({
      ...baseRoutes(),
      "GET /billing/plans": () => json(billingPlans()),
      "GET /billing/me": () => json(billingMe({ enabled: true, can_host: false })),
      "POST /billing/orders": () => json(order, 201),
      "POST /billing/verify": () =>
        json(
          billingMe({
            enabled: true,
            can_host: true,
            hosting_until: until,
            plan: "host-yearly",
            payments: [
              { id: "p1", plan: "host-yearly", amount_paise: 499900, currency: "INR", status: "PAID", razorpay_payment_id: "pay_123", test: false, created_at: until, paid_at: until },
            ],
          }),
        ),
    });
    renderSignedIn("/pricing");
    const yearly = await screen.findByRole("article", { name: "Host Yearly" });
    expect(yearly).toHaveTextContent("₹4,999");
    expect(yearly).toHaveTextContent("Save 17%");
    expect(await screen.findByText("No plan yet")).toBeInTheDocument();

    await userEvent.click(within(yearly).getByRole("button", { name: /get host yearly/i }));
    expect(await within(yearly).findByText(/payment received/i)).toBeInTheDocument();
    // The browser names only the plan; the price comes from the server.
    expect(api.bodiesFor("POST /billing/orders")).toEqual([{ plan: "host-yearly" }]);
    expect(opened[0]).toMatchObject({ key: "rzp_test_key", order_id: "order_1", amount: 499900, currency: "INR" });
    expect(api.bodiesFor("POST /billing/verify")).toEqual([
      { razorpay_order_id: "order_1", razorpay_payment_id: "pay_123", razorpay_signature: "sig" },
    ]);
    expect(screen.getByText("Hosting is on")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Payments" })).toHaveTextContent("pay_123");
  });

  it("changes nothing when the checkout is closed", async () => {
    fakeCheckout("close");
    const api = mockApi({
      ...baseRoutes(),
      "GET /billing/plans": () => json(billingPlans()),
      "GET /billing/me": () => json(billingMe({ enabled: true, can_host: false })),
      "POST /billing/orders": () => json({ ...order, plan: "host-monthly", amount_paise: 49900 }, 201),
    });
    renderSignedIn("/pricing");
    const monthly = await screen.findByRole("article", { name: "Host Monthly" });
    await userEvent.click(within(monthly).getByRole("button", { name: /get host monthly/i }));
    await waitFor(() => expect(within(monthly).getByRole("button", { name: /get host monthly/i })).toBeEnabled());
    expect(api.calls.some((c) => c.key === "POST /billing/verify")).toBe(false);
  });

  it("buys a plan with the test checkout when there is no Razorpay", async () => {
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const api = mockApi({
      ...baseRoutes(),
      "GET /billing/plans": () => json(billingPlans({ mode: "test", key_id: null })),
      "GET /billing/me": () => json(billingMe({ enabled: true, mode: "test", required: true, can_host: false })),
      "POST /billing/orders": () =>
        json({ ...order, order_id: "test_order_1", mode: "test", key_id: null, plan: "host-monthly", plan_name: "Host Monthly", amount_paise: 49900 }, 201),
      "POST /billing/test-pay": () =>
        json(
          billingMe({
            enabled: true,
            mode: "test",
            required: true,
            can_host: true,
            hosting_until: until,
            plan: "host-monthly",
            payments: [
              { id: "p1", plan: "host-monthly", amount_paise: 49900, currency: "INR", status: "PAID", razorpay_payment_id: "test_pay_1", test: true, created_at: until, paid_at: until },
            ],
          }),
        ),
    });
    renderSignedIn("/pricing");
    expect(await screen.findByText(/test payments: no real money/i)).toBeInTheDocument();
    const monthly = screen.getByRole("article", { name: "Host Monthly" });
    await userEvent.click(within(monthly).getByRole("button", { name: /get host monthly/i }));

    const checkout = await screen.findByRole("dialog", { name: "Test checkout" });
    expect(checkout).toHaveTextContent("₹499");
    expect(checkout).toHaveTextContent(/no real money/i);
    await userEvent.click(within(checkout).getByRole("button", { name: "Pay ₹499" }));

    expect(await within(monthly).findByText(/payment received/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Test checkout" })).not.toBeInTheDocument();
    expect(api.bodiesFor("POST /billing/test-pay")).toEqual([{ order_id: "test_order_1" }]);
    expect(window.Razorpay).toBeUndefined();
    const history = screen.getByRole("table", { name: "Payments" });
    expect(history).toHaveTextContent("Test");
  });

  it("says hosting is free when plans are not required", async () => {
    mockApi(baseRoutes());
    renderSignedIn("/pricing");
    expect(await screen.findByText(/hosting is free on this server/i)).toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Host Monthly" })).getByRole("button", { name: /not needed here/i })).toBeDisabled();
  });

  it("keeps hosting locked while payments are not switched on", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /billing/plans": () => json(billingPlans({ enabled: false, key_id: null })),
      "GET /billing/me": () => json(billingMe({ required: true, can_host: false })),
    });
    renderSignedIn("/pricing");
    expect(await screen.findByText(/payments aren't switched on yet/i)).toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Host Monthly" })).getByRole("button", { name: /coming soon/i })).toBeDisabled();
  });

  it("sends someone without a plan to the plans instead of the contest wizard", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /billing/me": () => json(billingMe({ enabled: true, required: true, can_host: false })),
      "GET /studio/problems": () => json(paginated([])),
    });
    renderSignedIn("/host");
    const main = screen.getByRole("main");
    const links = await within(main).findAllByRole("link", { name: /get a host plan/i });
    expect(links.map((l) => l.getAttribute("href"))).toEqual(links.map(() => "/pricing"));
    expect(within(screen.getByRole("main")).queryByRole("link", { name: /^host a contest$/i })).not.toBeInTheDocument();
  });

  it("shows the plan screen in place of the wizard", async () => {
    mockApi({
      ...baseRoutes(),
      "GET /billing/me": () => json(billingMe({ enabled: true, required: true, can_host: false })),
    });
    renderSignedIn("/contests/new");
    expect(await screen.findByRole("link", { name: /see host plans/i })).toHaveAttribute("href", "/pricing");
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
  });

  it("asks for a plan before publishing a contest", async () => {
    const draft: ContestDetail = {
      contest: {
        slug: "round-1",
        title: "Round 1",
        format: "ICPC",
        starts_at: new Date(Date.now() + 86_400_000).toISOString(),
        ends_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        duration_minutes: 120,
        phase: "UPCOMING",
        published: false,
        authors: ["ada"],
        problem_count: 1,
        participants: 0,
        registered: false,
        my_role: "OWNER",
      },
      description: "",
      problems: [{ label: "A", slug: "sum", title: "Sum", points: 1, solved_by: 0, my_status: null }],
      problems_visible: true,
      editorial_available: false,
      server_time: new Date().toISOString(),
    };
    mockApi({
      ...baseRoutes(),
      "GET /contests/round-1": () => json(draft),
      "GET /studio/problems": () => json(paginated([])),
      "GET /contests/round-1/editorial": () => json({ intro: "", problems: [], is_public: false }),
      "GET /billing/me": () => json(billingMe({ enabled: true, can_host: false })),
    });
    renderSignedIn("/contests/round-1/manage");
    const panel = await screen.findByRole("region", { name: "Publishing" });
    expect(await within(panel).findByText("Publishing needs a Host plan")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: /see host plans/i })).toHaveAttribute("href", "/pricing");
    expect(within(panel).queryByRole("button", { name: /publish contest/i })).not.toBeInTheDocument();
  });
});
