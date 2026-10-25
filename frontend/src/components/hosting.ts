import { useQuery } from "@tanstack/react-query";
import { billingApi } from "../api/endpoints";
import { useViewer } from "../auth/AuthContext";

/**
 * Where "Host a contest" should lead this viewer: the contest wizard when they
 * may host, else the Host plans page. Until the plan status has loaded it
 * assumes they may, and the server checks again when they create anything.
 */
export function useHosting() {
  const { ready, signedIn } = useViewer();
  const me = useQuery({
    queryKey: ["billing-me"],
    queryFn: () => billingApi.me(),
    enabled: ready && signedIn,
    staleTime: 60_000,
  });
  const canHost = signedIn && (me.data ? me.data.can_host : true);
  return {
    canHost,
    to: canHost ? "/contests/new" : signedIn ? "/pricing" : "/register",
    label: canHost ? "Host a contest" : signedIn ? "Get a Host plan" : "Create an account to host",
  };
}
