import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AtSign, X } from "lucide-react";
import { ApiError } from "../api/client";
import { authApi } from "../api/endpoints";
import type { User } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { Avatar } from "./people";

const USERNAME = /^[A-Za-z0-9_-]{3,32}$/;

/**
 * Your name and username. The name is what standings and your profile show
 * (blank shows the username); the username is your address, /u/<username>.
 */
export function EditProfileForm({ user: u, onSaved, onCancel }: { user: User; onSaved?: (next: User) => void; onCancel?: () => void }) {
  const qc = useQueryClient();
  const { refreshUser } = useAuth();
  const [name, setName] = useState(u.display_name ?? "");
  const [username, setUsername] = useState(u.username);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const nameChanged = name.trim() !== (u.display_name ?? "");
  const usernameChanged = username.trim() !== u.username;
  const usernameError =
    username.trim() && !USERNAME.test(username.trim()) ? "3–32 characters: letters, digits, “_” or “-”." : null;

  const save = useMutation({
    mutationFn: () =>
      authApi.updateMe({
        ...(nameChanged ? { display_name: name.trim() } : {}),
        ...(usernameChanged ? { username: username.trim() } : {}),
      }),
    onSuccess: async (next) => {
      qc.setQueryData(["me"], next);
      void qc.invalidateQueries({ queryKey: ["profile"] });
      await refreshUser();
      setNote({ ok: true, text: "Saved." });
      onSaved?.(next);
    },
    onError: (e) => setNote({ ok: false, text: e instanceof ApiError ? e.message : "Couldn't save. Please try again." }),
  });

  const preview = name.trim() || username.trim() || u.username;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setNote(null);
        if (name.trim().length > 60) return setNote({ ok: false, text: "The name can be at most 60 characters." });
        if (usernameError || !username.trim()) return setNote({ ok: false, text: usernameError ?? "Choose a username." });
        save.mutate();
      }}
    >
      <div className="flex items-center gap-3 rounded-xl border border-line bg-paper/50 p-3">
        <Avatar username={username.trim() || u.username} url={u.avatar_url} size={40} />
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink">{preview}</p>
          <p className="truncate text-xs text-muted">@{username.trim() || u.username}</p>
        </div>
        <span className="ml-auto text-[0.6875rem] uppercase tracking-[0.1em] text-faint">Preview</span>
      </div>
      <div>
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
        <p className="mt-1 text-xs text-faint">Shown on your profile and in standings. Leave it empty to show your username.</p>
      </div>
      <div>
        <label htmlFor="username" className="label">
          Username
        </label>
        <div className="relative">
          <AtSign size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" aria-hidden="true" />
          <input
            id="username"
            className="input pl-9"
            value={username}
            maxLength={32}
            autoComplete="username"
            spellCheck={false}
            aria-invalid={usernameError ? true : undefined}
            aria-describedby="username-help"
            onChange={(e) => {
              setNote(null);
              setUsername(e.target.value.replace(/\s/g, ""));
            }}
          />
        </div>
        <p id="username-help" className={`mt-1 text-xs ${usernameError ? "text-bad" : "text-faint"}`}>
          {usernameError ??
            (usernameChanged
              ? `Your profile moves to /u/${username.trim()}; links to /u/${u.username} stop working.`
              : "Letters, digits, “_” and “-”. Your profile lives at /u/" + u.username + ".")}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {note && (
          <p role={note.ok ? "status" : "alert"} className={`mr-auto text-sm ${note.ok ? "text-good" : "text-bad"}`}>
            {note.text}
          </p>
        )}
        {onCancel && (
          <button type="button" className="btn btn-outline" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={(!nameChanged && !usernameChanged) || save.isPending}>
          {save.isPending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

/** The same form in a dialog, opened from your public profile. */
export function EditProfileDialog({ user, onClose, onSaved }: { user: User; onClose: () => void; onSaved: (next: User) => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.querySelector<HTMLInputElement>("#display-name")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // On <body>, so no transformed or clipped ancestor can trap the fixed overlay.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-paper/80 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="edit-profile-title" className="card animate-pop relative w-full max-w-md p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="edit-profile-title" className="text-lg font-semibold text-ink">
            Edit profile
          </h2>
          <button type="button" className="btn btn-ghost min-h-[32px] px-2" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <EditProfileForm user={user} onCancel={onClose} onSaved={onSaved} />
      </div>
    </div>,
    document.body,
  );
}
