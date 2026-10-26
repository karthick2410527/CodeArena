import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BadgeCheck,
  ChevronDown,
  FileCode2,
  History,
  LogOut,
  Medal,
  Menu,
  Palette,
  PenSquare,
  Plus,
  Search,
  Settings,
  Shield,
  Swords,
  Trophy,
  UserCircle2,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { contestsApi } from "../api/endpoints";
import { useHosting } from "./hosting";
import { useAuth, useViewer } from "../auth/AuthContext";
import { THEMES, useDisplay, type ThemeName } from "../display";
import ErrorBoundary from "./ErrorBoundary";
import LiveContestBanner from "./LiveContestBanner";
import { Avatar } from "./people";
import SearchPalette, { useSearchShortcut } from "./SearchPalette";
import { ThemeSwitcher, Wordmark } from "./ui";

type Item = {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
  hint?: string;
  /** Which paths count as this section; by default the link and everything under it. */
  match?: (path: string) => boolean;
};

/** Hosting lives under Host even where its pages sit under other paths (a contest's manage page, plans). */
const isHostPath = (path: string) =>
  path === "/host" ||
  path.startsWith("/studio") ||
  path === "/contests/new" ||
  /^\/contests\/[^/]+\/manage$/.test(path) ||
  path === "/pricing";

/** What the top bar offers this viewer; the phone sheet shows the same lists. */
function useNav() {
  const { user } = useAuth();
  const { ready, signedIn } = useViewer();
  // Shares its cache with the live-contest banner, so this costs no extra request.
  const running = useQuery({
    queryKey: ["contests", "running"],
    queryFn: () => contestsApi.list("running"),
    enabled: ready,
    refetchInterval: 60_000,
  });
  const live = (running.data?.items.length ?? 0) > 0;
  const host = useHosting();
  const primary: Item[] = [
    { to: "/problems", label: "Problems", icon: FileCode2 },
    {
      to: "/contests",
      label: "Contests",
      icon: Trophy,
      badge: live ? "Live" : undefined,
      match: (p) => (p === "/contests" || p.startsWith("/contests/")) && !isHostPath(p),
    },
    ...(signedIn ? [{ to: "/host", label: "Host", icon: Swords, match: isHostPath }] : []),
    { to: "/people", label: "People", icon: Users },
    ...(signedIn ? [{ to: "/submissions", label: "Submissions", icon: History }] : []),
  ];
  const create: Item[] = signedIn
    ? [
        host.canHost
          ? { to: "/contests/new", label: "Host a contest", icon: Plus, hint: "Set up a round in four steps" }
          : { to: "/pricing", label: "Get a Host plan", icon: BadgeCheck, hint: "Needed to host contests, from ₹499/month" },
        { to: "/studio/problems", label: "My problems", icon: PenSquare, hint: "Write problems for your contests" },
        { to: "/host", label: "Hosted contests", icon: Swords, hint: "Rounds you host or co-author" },
        ...(host.canHost ? [{ to: "/pricing", label: "Host plan", icon: BadgeCheck, hint: "Your plan and payments" }] : []),
      ]
    : [];
  const admin: Item[] =
    signedIn && user?.role === "ADMIN"
      ? [
          { to: "/admin/problems", label: "Problems", icon: Shield, hint: "Every problem, any owner" },
          { to: "/admin/ops", label: "Judge", icon: Activity, hint: "Queues, workers and dead letters" },
        ]
      : [];
  return { primary, create, admin };
}

/** True once the page has scrolled, so the bar can turn solid. Only colours change, never its size. */
function useScrolled() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 4);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return scrolled;
}

/**
 * The app frame: a sticky top bar (navigation, create, search, theme,
 * account) over a centred page. Below the large breakpoint the navigation
 * folds into a sheet behind the menu button.
 */
export default function Layout() {
  const nav = useNav();
  const { status } = useAuth();
  const [sheet, setSheet] = useState(false);
  const [searching, setSearching] = useState(false);
  const openSearch = useCallback(() => setSearching(true), []);
  useSearchShortcut(openSearch);
  const { pathname } = useLocation();
  useEffect(() => setSheet(false), [pathname]);
  const scrolled = useScrolled();
  // A contest's tabs are one page, so moving between them doesn't replay the entrance.
  const pageKey = pathname.split("/").slice(0, 3).join("/");

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-surface focus:p-3"
      >
        Skip to content
      </a>

      <header
        className={`sticky top-0 z-40 border-b transition-[background-color,border-color] duration-300 ${
          scrolled || sheet ? "border-line/70 bg-paper/80 backdrop-blur-xl backdrop-saturate-150" : "border-transparent bg-paper/0"
        }`}
      >
        <div className="mx-auto flex h-16 w-full max-w-[90rem] items-center gap-2 px-4 sm:px-8">
          <div className="mr-2 shrink-0 lg:mr-4">
            <Wordmark />
          </div>
          <PrimaryNav items={nav.primary} />
          <div className="ml-auto flex items-center gap-1.5">
            <SearchButton onClick={openSearch} />
            {nav.admin.length > 0 && (
              <Dropdown label="Admin" icon={Shield} items={nav.admin} className="hidden lg:block" />
            )}
            <ThemeMenu />
            {status === "authenticated" ? (
              <UserMenu />
            ) : (
              <div className="hidden items-center gap-1.5 sm:flex">
                <Link to="/login" className="btn btn-ghost min-h-[36px] px-3.5">
                  Sign in
                </Link>
                <Link to="/register" className="btn btn-primary min-h-[36px] px-4">
                  Get started
                </Link>
              </div>
            )}
            <button
              type="button"
              onClick={() => setSheet((o) => !o)}
              className="grid h-9 w-9 place-items-center rounded-full text-muted transition-colors hover:bg-sunken hover:text-ink lg:hidden"
              aria-label={sheet ? "Close the menu" : "Open the menu"}
              aria-expanded={sheet}
            >
              {sheet ? <X size={19} /> : <Menu size={19} />}
            </button>
          </div>
        </div>
      </header>

      {sheet && <MobileSheet nav={nav} signedIn={status === "authenticated"} onClose={() => setSheet(false)} />}

      {pathname === "/" ? (
        // The landing page runs edge to edge and lays out its own sections.
        <main id="main" className="-mt-16 flex-1">
          <ErrorBoundary key={pageKey}>
            <Outlet />
          </ErrorBoundary>
        </main>
      ) : (
        <main id="main" className="mx-auto w-full max-w-[90rem] flex-1 px-4 pb-20 pt-6 sm:px-8 sm:pt-8">
          <LiveContestBanner />
          <div key={pageKey} className="animate-page">
            <ErrorBoundary key={pathname}>
              <Outlet />
            </ErrorBoundary>
          </div>
        </main>
      )}
      <Footer />
      <SearchPalette open={searching} onClose={() => setSearching(false)} />
    </div>
  );
}

/** The main links, with a highlight that glides to the current one. */
function PrimaryNav({ items }: { items: Item[] }) {
  const ref = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const on = el.querySelector<HTMLElement>('a[aria-current="page"]');
      setPill(on ? { left: on.offsetLeft, width: on.offsetWidth } : null);
    };
    place();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [pathname, items.length]);

  return (
    <nav ref={ref} aria-label="Primary" className="relative hidden items-center rounded-full border border-line/60 bg-surface/50 p-1 backdrop-blur lg:flex">
      <span
        aria-hidden="true"
        className="absolute top-1 h-9 rounded-full bg-sunken shadow-sm transition-[transform,width,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{ left: 0, width: pill?.width ?? 0, transform: `translateX(${pill?.left ?? 0}px)`, opacity: pill ? 1 : 0 }}
      />
      {items.map(({ to, label, badge, match }) => (
        <Link
          key={to}
          to={to}
          className="topnav-link"
          aria-current={(match ? match(pathname) : pathname === to || pathname.startsWith(`${to}/`)) ? "page" : undefined}
        >
          {label}
          {badge && (
            <span className="flex items-center gap-1 rounded-full bg-good/15 px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-good">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-good" aria-hidden="true" />
              {badge}
            </span>
          )}
        </Link>
      ))}
    </nav>
  );
}

/** Open/close state for a small popover: a click outside, Escape or a new page closes it. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, box };
}

function Dropdown({ label, icon: Icon, items, className = "" }: { label: string; icon: LucideIcon; items: Item[]; className?: string }) {
  const { open, setOpen, box } = usePopover();
  return (
    <div className={`relative ${className}`} ref={box}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors ${
          open ? "bg-sunken text-ink" : "text-muted hover:bg-sunken/70 hover:text-ink"
        }`}
      >
        <Icon size={15} aria-hidden="true" />
        {label}
        <ChevronDown size={14} className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="panel animate-pop absolute right-0 top-full z-50 mt-2 w-72 p-1.5">
          <nav aria-label={label}>
            <ul>
              {items.map((i) => (
                <li key={i.to}>
                  <PopoverLink item={i} />
                </li>
              ))}
            </ul>
          </nav>
        </div>
      )}
    </div>
  );
}

function PopoverLink({ item: { to, label, icon: Icon, hint } }: { item: Item }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `group flex items-start gap-3 rounded-xl px-2.5 py-2 transition-colors ${isActive ? "bg-accent/10" : "hover:bg-sunken"}`
      }
    >
      <span className="icon-tile mt-0.5 h-8 w-8 shrink-0 rounded-lg">
        <Icon size={15} aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {hint && <span className="block text-xs text-faint">{hint}</span>}
      </span>
    </NavLink>
  );
}

function SearchButton({ onClick }: { onClick: () => void }) {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Search"
      title={`Search (${mac ? "⌘K" : "Ctrl K"})`}
      className="flex h-9 items-center gap-2 rounded-full border border-line/70 bg-surface/60 px-2.5 text-sm text-faint transition-colors hover:border-line-strong hover:text-muted xl:w-56 xl:px-3.5"
    >
      <Search size={15} aria-hidden="true" />
      <span className="hidden flex-1 text-left xl:inline">Search…</span>
      <kbd className="hidden rounded-md border border-line px-1.5 font-mono text-[0.6875rem] xl:inline">{mac ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  );
}

/** Swatches for each theme: page, surface and accent. */
const SWATCH: Record<ThemeName, [string, string, string]> = {
  light: ["#f6f5f1", "#fdfdfb", "#3a2bea"],
  sand: ["#f4efe5", "#fbf8f2", "#ba400e"],
  dark: ["#0d0e12", "#16181e", "#857cff"],
  midnight: ["#070c19", "#0c1426", "#38bdf8"],
  emerald: ["#f6f6f3", "#fdfdfc", "#16804a"],
};

function ThemeMenu() {
  const { open, setOpen, box } = usePopover();
  const [display, setDisplay] = useDisplay();
  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Theme"
        title="Theme"
        className={`grid h-9 w-9 place-items-center rounded-full transition-colors ${
          open ? "bg-sunken text-ink" : "text-muted hover:bg-sunken/70 hover:text-ink"
        }`}
      >
        <Palette size={17} aria-hidden="true" />
      </button>
      {open && (
        <div className="panel animate-pop absolute right-0 top-full z-50 mt-2 w-56 p-1.5">
          <p className="px-2.5 pb-1 pt-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-faint">Theme</p>
          <div role="radiogroup" aria-label="Colour theme">
            {THEMES.map(([t, label]) => {
              const on = display.theme === t;
              const [paper, surface, accent] = SWATCH[t];
              return (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={label}
                  onClick={() => setDisplay({ theme: t })}
                  className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm transition-colors ${
                    on ? "bg-accent/10 text-ink" : "text-muted hover:bg-sunken hover:text-ink"
                  }`}
                >
                  <span className="relative h-6 w-9 shrink-0 overflow-hidden rounded-md ring-1 ring-line-strong/50" style={{ background: paper }} aria-hidden="true">
                    <span className="absolute bottom-0 right-0 h-4 w-6 rounded-tl-md" style={{ background: surface }} />
                    <span className="absolute bottom-1 right-1 h-1.5 w-3 rounded-full" style={{ background: accent }} />
                  </span>
                  <span className="flex-1 font-medium">{label}</span>
                  {on && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Who is signed in, and the account actions. */
function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { open, setOpen, box } = usePopover();
  if (!user) return null;
  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };
  const signOut = async () => {
    setOpen(false);
    await logout();
    navigate("/");
  };
  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className={`flex h-9 items-center gap-2 rounded-full pl-0.5 pr-0.5 transition-colors sm:pr-2.5 ${open ? "bg-sunken" : "hover:bg-sunken/70"}`}
      >
        <Avatar username={user.username} url={user.avatar_url} size={32} />
        <span className="hidden max-w-[9rem] truncate text-sm font-medium text-ink sm:inline">{user.display_name ?? user.username}</span>
        <ChevronDown size={14} className="hidden text-faint sm:block" aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" aria-label="Account" className="panel animate-pop absolute right-0 top-full z-50 mt-2 w-60 p-1.5">
          <div className="flex items-center gap-3 px-2.5 py-2">
            <Avatar username={user.username} url={user.avatar_url} size={36} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{user.display_name ?? user.username}</p>
              <p className="truncate text-xs text-faint">{user.email ?? `@${user.username}`}</p>
            </div>
          </div>
          <div className="my-1 h-px bg-line" />
          <MenuItem icon={UserCircle2} onClick={() => go(`/u/${encodeURIComponent(user.username)}`)}>
            Your profile
          </MenuItem>
          <MenuItem icon={Medal} onClick={() => go("/contests/joined")}>
            Joined contests
          </MenuItem>
          <MenuItem icon={History} onClick={() => go("/submissions")}>
            Submissions
          </MenuItem>
          <MenuItem icon={Settings} onClick={() => go("/profile")}>
            Account settings
          </MenuItem>
          <div className="my-1 h-px bg-line" />
          <MenuItem icon={LogOut} onClick={signOut}>
            Sign out
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, onClick, children }: { icon: LucideIcon; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-muted transition-colors hover:bg-sunken hover:text-ink"
    >
      <Icon size={15} aria-hidden="true" />
      {children}
    </button>
  );
}

/** Phones and small windows: everything from the bar, stacked. */
function MobileSheet({ nav, signedIn, onClose }: { nav: ReturnType<typeof useNav>; signedIn: boolean; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const section = (title: string, items: Item[]) =>
    items.length > 0 && (
      <div>
        <p className="mb-1 px-2.5 text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-faint">{title}</p>
        <ul className="grid gap-0.5 sm:grid-cols-2">
          {items.map((i) => (
            <li key={i.to}>
              <PopoverLink item={i} />
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="fixed inset-x-0 bottom-0 top-16 z-30 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
      <div className="absolute inset-0 bg-paper/60 backdrop-blur-sm animate-[vr-fade_200ms_ease-out]" onClick={onClose} />
      <div className="animate-pop relative max-h-full overflow-y-auto border-b border-line/70 bg-paper px-4 pb-6 pt-3 shadow-panel sm:px-8">
        <div className="space-y-5">
          {section("Explore", nav.primary)}
          {section("Host", nav.create)}
          {section("Admin", nav.admin)}
          <div>
            <p className="mb-2 px-2.5 text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-faint">Theme</p>
            <ThemeSwitcher />
          </div>
          {!signedIn && (
            <div className="grid grid-cols-2 gap-2">
              <Link to="/login" className="btn btn-outline">
                Sign in
              </Link>
              <Link to="/register" className="btn btn-primary">
                Get started
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line/60">
      <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-4 px-4 py-8 text-sm text-faint sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <div className="flex items-center gap-3">
          <Wordmark />
          <span className="hidden sm:inline">Practice, compete, and watch your code run.</span>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
          <Link to="/problems" className="hover:text-ink">
            Problems
          </Link>
          <Link to="/contests" className="hover:text-ink">
            Contests
          </Link>
          <Link to="/people" className="hover:text-ink">
            People
          </Link>
          <Link to="/pricing" className="hover:text-ink">
            Pricing
          </Link>
        </nav>
      </div>
    </footer>
  );
}
