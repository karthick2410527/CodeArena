import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "../api/endpoints";
import type { User } from "../api/types";
import ConnectedAccounts from "../components/ConnectedAccounts";
import { EditProfileForm } from "../components/EditProfile";
import { ErrorState, Spinner } from "../components/Feedback";
import { ProfileView } from "./UserProfilePage";

/** Your public profile, plus the private account details only you see. */
export default function ProfilePage() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => authApi.me() });
  if (me.isPending) return <Spinner label="Loading profile…" />;
  if (me.isError) {
    return <ErrorState title="Couldn't load your profile" message={me.error.message} onRetry={() => me.refetch()} />;
  }
  return <ProfileView username={me.data.username} account={<Account user={me.data} />} />;
}

function Account({ user: u }: { user: User }) {
  return (
    <section className="card p-5 sm:p-6" aria-labelledby="account-h">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="account-h" className="text-lg font-semibold text-ink">
          Your account
        </h2>
        <Link to={`/u/${encodeURIComponent(u.username)}`} className="text-sm text-accent hover:underline">
          View as others see it →
        </Link>
      </div>
      <div className="mt-4">
        <EditProfileForm user={u} />
      </div>
      <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <Row label="Email" value={u.email ?? "—"} />
        <Row label="Role" value={u.role} />
        <Row label="Member since" value={new Date(u.created_at).toLocaleDateString()} />
      </dl>
      <ConnectedAccounts user={u} />
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line/60 py-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate text-ink">{value}</dd>
    </div>
  );
}
