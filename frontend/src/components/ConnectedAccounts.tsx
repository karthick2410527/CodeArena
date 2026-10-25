import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authApi } from "../api/endpoints";
import { ApiError } from "../api/client";
import type { User } from "../api/types";
import { Notice, ProviderIcon } from "./ui";

/**
 * Sign-in methods on the profile: the password (if any) and each provider
 * the server offers, connected or not. The API refuses to remove the last
 * way to sign in, and this list says so before anyone tries.
 */
export default function ConnectedAccounts({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const providers = useQuery({ queryKey: ["auth-providers"], queryFn: authApi.providers, staleTime: 5 * 60_000 });
  const identities = useQuery({ queryKey: ["identities"], queryFn: authApi.identities });

  const connect = useMutation({
    mutationFn: (provider: string) => authApi.linkIntent(provider),
    onSuccess: ({ authorize_url }) => window.location.assign(authorize_url),
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not start connecting. Please try again."),
  });
  const disconnect = useMutation({
    mutationFn: (provider: string) => authApi.unlink(provider),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["identities"] }),
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not disconnect. Please try again."),
  });

  if (!providers.data || providers.data.length === 0 || !identities.data) return null;

  const linked = new Map(identities.data.map((i) => [i.provider, i]));
  const methods = linked.size + (user.has_password ? 1 : 0);
  const justLinked = params.get("linked");

  return (
    <section className="mt-8">
      <h2 className="mb-4 text-lg font-semibold text-ink">Sign-in methods</h2>
      <div className="space-y-3">
        {justLinked && linked.has(justLinked as "google" | "github") && (
          <Notice tone="good">Connected. You can now sign in with it.</Notice>
        )}
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="card divide-y divide-line">
          <div className="flex items-center justify-between px-5 py-3 text-sm">
            <span className="text-ink">Email and password</span>
            <span className="text-muted">{user.has_password ? "Set" : "Not set"}</span>
          </div>
          {providers.data.map((p) => {
            const identity = linked.get(p.id);
            const lastMethod = identity !== undefined && methods <= 1;
            return (
              <div key={p.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                <span className="flex min-w-0 items-center gap-2.5 text-ink">
                  <ProviderIcon provider={p.id} />
                  <span className="truncate">
                    {p.name}
                    {identity && (
                      <span className="ml-2 text-muted">{identity.login ?? identity.email ?? "connected"}</span>
                    )}
                  </span>
                </span>
                {identity ? (
                  <button
                    type="button"
                    className="btn-ghost min-h-[34px] px-3"
                    disabled={lastMethod || disconnect.isPending}
                    title={lastMethod ? "Your only way to sign in: connect another one first" : undefined}
                    onClick={() => {
                      setError(null);
                      disconnect.mutate(p.id);
                    }}
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-outline min-h-[34px] px-3"
                    disabled={connect.isPending || !p.enabled}
                    title={p.enabled ? undefined : `${p.name} sign-in isn’t set up on this server yet`}
                    onClick={() => {
                      setError(null);
                      connect.mutate(p.id);
                    }}
                  >
                    Connect
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
