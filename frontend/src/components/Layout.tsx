import { useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

const navLink = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-2 text-sm font-medium transition ${
    isActive ? "bg-slate-800 text-white" : "text-slate-300 hover:bg-slate-800/60 hover:text-white"
  }`;

export default function Layout() {
  const { status, user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const handleLogout = async () => {
    setOpen(false);
    await logout();
    navigate("/");
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-[90rem] items-center justify-between px-4 py-3">
          <Link
            to="/"
            className="flex items-center gap-2 text-lg font-bold tracking-tight text-white"
          >
            <span className="grid h-7 w-7 place-items-center rounded-md bg-indigo-600 font-mono text-sm">
              {"</>"}
            </span>
            CodeArena
          </Link>

          <button
            type="button"
            className="btn btn-ghost md:hidden"
            aria-label="Toggle menu"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            ☰
          </button>

          <nav
            className={`${
              open ? "flex" : "hidden"
            } absolute left-0 right-0 top-full flex-col gap-1 border-b border-slate-800 bg-slate-950 p-4 md:static md:flex md:flex-row md:items-center md:gap-2 md:border-0 md:bg-transparent md:p-0`}
            onClick={() => setOpen(false)}
          >
            <NavLink to="/problems" className={navLink}>
              Problems
            </NavLink>
            {status === "authenticated" && user ? (
              <>
                <NavLink to="/submissions" className={navLink}>
                  Submissions
                </NavLink>
                {user.role === "ADMIN" && (
                  <>
                    <NavLink to="/admin/problems" className={navLink}>
                      Admin
                    </NavLink>
                    <NavLink to="/admin/ops" className={navLink}>
                      Judge
                    </NavLink>
                  </>
                )}
                <NavLink to="/profile" className={navLink}>
                  {user.username}
                </NavLink>
                <button type="button" className="btn btn-outline" onClick={handleLogout}>
                  Log out
                </button>
              </>
            ) : status === "anonymous" ? (
              <>
                <Link to="/login" className="btn btn-ghost">
                  Log in
                </Link>
                <Link to="/register" className="btn btn-primary">
                  Sign up
                </Link>
              </>
            ) : null}
          </nav>
        </div>
      </header>

      {/* Wider than Phase 1: the problem page is a two-pane workspace. */}
      <main className="mx-auto w-full max-w-[90rem] flex-1 px-4 py-8">
        <Outlet />
      </main>

      <footer className="border-t border-slate-800 py-6 text-center text-xs text-slate-500">
        CodeArena · C++17 online judge
      </footer>
    </div>
  );
}
