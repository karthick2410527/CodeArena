import { useEffect, useState } from "react";

// How the coding workspace is laid out, per viewer: a convenience kept in
// local storage (guarded, like display.ts), never anything that must persist.

export interface EditorPrefs {
  /** Editor font size in px. */
  fontSize: number;
  /** Editor height in px. */
  height: number;
  wrap: boolean;
  /** Width of the statement column, as a percentage of the workspace. */
  split: number;
  /** Hide the statement and give the editor the whole width. */
  focus: boolean;
}

export const EDITOR_LIMITS = { fontMin: 11, fontMax: 22, heightMin: 260, heightMax: 1100, splitMin: 25, splitMax: 75 };

const DEFAULTS: EditorPrefs = { fontSize: 14, height: 460, wrap: false, split: 50, focus: false };
const KEY = "vr.editor";
const EVENT = "vr:editor";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function loadEditorPrefs(): EditorPrefs {
  try {
    const p = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as Partial<EditorPrefs> | null;
    const L = EDITOR_LIMITS;
    return {
      fontSize: clamp(Number(p?.fontSize) || DEFAULTS.fontSize, L.fontMin, L.fontMax),
      height: clamp(Number(p?.height) || DEFAULTS.height, L.heightMin, L.heightMax),
      wrap: p?.wrap === true,
      split: clamp(Number(p?.split) || DEFAULTS.split, L.splitMin, L.splitMax),
      focus: p?.focus === true,
    };
  } catch {
    return DEFAULTS;
  }
}

export function setEditorPrefs(change: Partial<EditorPrefs>) {
  const next = { ...loadEditorPrefs(), ...change };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the change still applies to this page */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
}

export function useEditorPrefs(): [EditorPrefs, (change: Partial<EditorPrefs>) => void] {
  const [p, setP] = useState<EditorPrefs>(loadEditorPrefs);
  useEffect(() => {
    const on = (e: Event) => setP((e as CustomEvent<EditorPrefs>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return [p, setEditorPrefs];
}
