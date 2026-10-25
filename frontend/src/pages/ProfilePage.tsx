import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { authApi } from "../api/endpoints";
import type { User } from "../api/types";
import ConnectedAccounts from "../components/ConnectedAccounts";
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
      <NameForm user={u} />
      <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <Row label="Username" value={u.username} />
        <Row label="Email" value={u.email ?? "—"} />
        <Row label="Role" value={u.role} />
        <Row label="Member since" value={new Date(u.created_at).toLocaleDateString()} />
      </dl>
      <ConnectedAccounts user={u} />
    </section>
  );
}

/** The display name, editable in place. */
function NameForm({ user: u }: { user: User }) {
  const qc = useQueryClient();
  const { refreshUser } = useAuth();
  const [name, setName] = useState(u.display_name ?? "");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const save = useMutation({
    mutationFn: () => authApi.updateMe({ display_name: name.trim() }),
    onSuccess: async (next) => {
      qc.setQueryData(["me"], next);
      void qc.invalidateQueries({ queryKey: ["profile"] });
      await refreshUser();
      setNote({ ok: true, text: "Name saved." });
    },
    onError: (e) => setNote({ ok: false, text: e instanceof ApiError ? e.message : "Couldn't save your name." }),
  });
  const changed = name.trim() !== (u.display_name ?? "");
  return (
    <form
      className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        setNote(null);
        if (name.trim().length > 60) {
          setNote({ ok: false, text: "At most 60 characters." });
          return;
        }
        save.mutate();
      }}
    >
      <div className="flex-1">
        <label htmlFor="display-name" className="label">
          Name
        </label>
        <input
          id="display-name"
          className="input"
          value={name}
          maxLength={60}
          placeholder={u.username}
          autoComplete="name"
          onChange={(e) => {
            setNote(null);
            setName(e.target.value);
          }}
        />
      </div>
      <button type="submit" className="btn btn-outline" disabled={!changed || save.isPending}>
        {save.isPending ? "Saving…" : "Save name"}
      </button>
      {note && (
        <p role={note.ok ? "status" : "alert"} className={`text-sm sm:ml-2 sm:self-center ${note.ok ? "text-good" : "text-bad"}`}>
          {note.text}
        </p>
      )}
    </form>
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
