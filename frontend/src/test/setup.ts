import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Node 25+ defines its own localStorage/sessionStorage globals (undefined
// unless node runs with --localstorage-file), and Vitest's jsdom environment
// does not replace globals that already exist. Point both at jsdom's.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
if (dom) {
  for (const key of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
}

// jsdom has no layout, so it does not scroll; pages still call scrollTo on navigation.
window.scrollTo = () => {};

afterEach(() => {
  cleanup();
  localStorage.clear();
});
