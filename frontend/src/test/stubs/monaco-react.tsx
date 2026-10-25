/**
 * Test stub for `@monaco-editor/react`.
 *
 * Renders a plain textarea with the same `value`/`onChange` contract, so tests
 * can type into "the editor" without loading the real Monaco bundle. The
 * production path is unaffected: `vite.config.ts` only aliases this under test.
 */
export interface StubEditorProps {
  value?: string;
  onChange?: (value: string | undefined) => void;
  options?: { readOnly?: boolean; ariaLabel?: string };
  beforeMount?: (monaco: unknown) => void;
}

export const loader = {
  config: () => {},
  init: () => Promise.resolve({}),
};

export default function Editor({ value, onChange, options }: StubEditorProps) {
  return (
    <textarea
      aria-label={options?.ariaLabel ?? "Source code"}
      readOnly={options?.readOnly}
      value={value ?? ""}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
}
