import { Suspense, lazy } from "react";

/**
 * Code editor with a toolbar.
 *
 * Monaco is loaded lazily so the problem statement renders before a 3 MB
 * editor bundle arrives, and so a browser that cannot load it still gets a
 * usable plain-text area rather than an empty box.
 */
const MonacoEditor = lazy(() => import("./MonacoEditor"));

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Monaco language id, e.g. `"cpp"`. */
  language: string;
  readOnly?: boolean;
  label?: string;
  /** Rendered on the right of the toolbar. */
  toolbar?: React.ReactNode;
  heightClass?: string;
}

export default function CodeEditor({
  value,
  onChange,
  language,
  readOnly,
  label = "Source code",
  toolbar,
  heightClass = "h-[22rem] lg:h-[28rem]",
}: CodeEditorProps) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/80 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          {label}
        </span>
        <div className="flex items-center gap-2">{toolbar}</div>
      </div>
      <div className={heightClass}>
        <Suspense fallback={<PlainEditor value={value} onChange={onChange} readOnly={readOnly} />}>
          <MonacoEditor
            value={value}
            onChange={onChange}
            language={language}
            readOnly={readOnly}
            ariaLabel={label}
          />
        </Suspense>
      </div>
    </div>
  );
}

/** Fallback while Monaco loads, and for environments where it cannot run. */
function PlainEditor({
  value,
  onChange,
  readOnly,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
}) {
  return (
    <textarea
      aria-label="Source code"
      spellCheck={false}
      readOnly={readOnly}
      className="h-full w-full resize-none bg-slate-950 p-3 font-mono text-sm text-slate-100 outline-none"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
