import { useEffect, useState } from "react";

// Display preferences are a per-viewer convenience. Storage can be
// unavailable (private windows, blocked site data), so every access is
// guarded and the app works without it.

export type ThemeName = "light" | "sand" | "dark" | "midnight" | "emerald";

export const THEMES: [ThemeName, string][] = [
  ["light", "Light"],
  ["sand", "Sand"],
  ["emerald", "Emerald"],
  ["dark", "Dark"],
  ["midnight", "Midnight"],
];

export const DARK_THEMES: ReadonlySet<ThemeName> = new Set(["dark", "midnight"]);

function isTheme(t: unknown): t is ThemeName {
  return THEMES.some(([name]) => name === t);
}

const KEY = "vr.display";
const EVENT = "vr:display";

export interface DisplayPrefs {
  theme: ThemeName;
}

export function loadDisplay(): DisplayPrefs {
  try {
    const p = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as Partial<DisplayPrefs> | null;
    // A theme that no longer exists (an older "soft" or "contrast") falls back to Light.
    return { theme: isTheme(p?.theme) ? p.theme : "light" };
  } catch {
    return { theme: "light" };
  }
}

export function applyDisplay(p: DisplayPrefs) {
  const el = document.documentElement;
  if (p.theme === "light") delete el.dataset.theme;
  else el.dataset.theme = p.theme;
}

/** Saves, applies and announces the preferences so every open control stays in sync. */
export function setDisplay(p: DisplayPrefs) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: the theme still applies for this page */
  }
  applyDisplay(p);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: p }));
}

export function useDisplay(): [DisplayPrefs, (p: DisplayPrefs) => void] {
  const [p, setP] = useState<DisplayPrefs>(loadDisplay);
  useEffect(() => {
    const on = (e: Event) => setP((e as CustomEvent<DisplayPrefs>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return [p, setDisplay];
}
