/**
 * Test stub for `monaco-editor`.
 *
 * The real package is a ~3 MB bundle with web workers, which jsdom cannot run
 * and which would dominate the suite's runtime. `vite.config.ts` aliases the
 * package to this file under test, so components that import Monaco still
 * compile while the tests drive the plain-textarea fallback instead.
 */
export const editor = {
  defineTheme: () => {},
  setModelMarkers: () => {},
};

export default { editor };
