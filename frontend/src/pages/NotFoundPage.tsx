import { Link } from "react-router-dom";
import { FileCode2, Search, Trophy } from "lucide-react";

/** A wrong address: say so plainly, then offer the places people usually meant. */
export default function NotFoundPage() {
  return (
    <div className="mx-auto max-w-xl py-12 text-center">
      <p
        className="font-display text-[7rem] font-semibold leading-none tracking-tighter"
        style={{
          background: "linear-gradient(180deg, rgb(var(--c-accent)) 0%, rgb(var(--c-accent) / 0.15) 100%)",
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
        }}
        aria-hidden="true"
      >
        404
      </p>
      <h1 className="mt-2 text-2xl font-semibold text-ink">Page not found</h1>
      <p className="mt-2 text-muted">The page you're looking for doesn't exist, or it moved.</p>
      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        {[
          ["/problems", "Browse problems", FileCode2],
          ["/contests", "See contests", Trophy],
          ["/people", "Find people", Search],
        ].map(([to, label, Icon]) => {
          const I = Icon as typeof Search;
          return (
            <Link key={to as string} to={to as string} className="card flex flex-col items-center gap-2 p-4 text-sm font-medium text-ink transition-colors hover:border-accent/40 hover:shadow-panel">
              <span className="icon-tile">
                <I size={18} aria-hidden="true" />
              </span>
              {label as string}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
