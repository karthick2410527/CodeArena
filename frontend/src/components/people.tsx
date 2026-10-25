import { Link } from "react-router-dom";

/** A round avatar: the user's picture, or their initial on the accent tint. */
export function Avatar({
  username,
  url,
  size = 28,
}: {
  username: string;
  url?: string | null;
  size?: number;
}) {
  if (url) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-full"
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-full bg-accent/15 font-semibold uppercase text-accent"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {username.slice(0, 1)}
    </span>
  );
}

/** A username linking to their public profile. */
export function UserLink({ username, className = "" }: { username: string; className?: string }) {
  return (
    <Link to={`/u/${encodeURIComponent(username)}`} className={`font-medium text-ink hover:text-accent ${className}`}>
      {username}
    </Link>
  );
}
