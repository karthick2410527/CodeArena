import { Suspense, lazy, useState, type PointerEvent } from "react";
import { Maximize2, Minimize2, Minus, Plus, WrapText } from "lucide-react";
import { EDITOR_LIMITS, useEditorPrefs } from "../editorPrefs";

/**
 * Code editor with a toolbar.
 *
 * Monaco is loaded lazily so the problem statement renders before a 3 MB
 * editor bundle arrives, and so a browser that cannot load it still gets a
 * usable plain-text area rather than an empty box.
 */
const MonacoEditor = lazy(() => import("./MonacoEditor"));
export type { EditorMarker } from "./MonacoEditor";

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
  /**
   * The coding workspace's editor: font size, word wrap and focus controls in
   * the toolbar, and a handle to drag its height, all remembered per viewer.
   */
  adjustable?: boolean;
  markers?: import("./MonacoEditor").EditorMarker[];
  jump?: { line: number; column?: number } | null;
}

export default function CodeEditor({
  value,
  onChange,
  language,
  readOnly,
  label = "Source code",
  toolbar,
  heightClass = "h-[22rem] lg:h-[28rem]",
  adjustable = false,
  markers,
  jump,
}: CodeEditorProps) {
  const [prefs, setPrefs] = useEditorPrefs();
  const [dragHeight, setDragHeight] = useState<{ start: number; from: number; now: number } | null>(null);
  const height = dragHeight?.now ?? prefs.height;
  const L = EDITOR_LIMITS;

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragHeight({ start: e.clientY, from: prefs.height, now: prefs.height });
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragHeight) return;
    const now = Math.min(L.heightMax, Math.max(L.heightMin, dragHeight.from + e.clientY - dragHeight.start));
    setDragHeight({ ...dragHeight, now });
  };
  const onUp = () => {
    if (dragHeight) setPrefs({ height: Math.round(dragHeight.now) });
    setDragHeight(null);
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface/80 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</span>
        <div className="flex flex-wrap items-center gap-2">
          {adjustable && (
            <div className="flex items-center gap-0.5 rounded-xl border border-line bg-paper/60 p-0.5" role="group" aria-label="Editor view">
              <IconButton label="Smaller text" onClick={() => setPrefs({ fontSize: Math.max(L.fontMin, prefs.fontSize - 1) })} disabled={prefs.fontSize <= L.fontMin}>
                <Minus size={13} />
              </IconButton>
              <span className="w-7 text-center font-mono text-[0.6875rem] text-muted" aria-label={`Font size ${prefs.fontSize}`}>
                {prefs.fontSize}
              </span>
              <IconButton label="Larger text" onClick={() => setPrefs({ fontSize: Math.min(L.fontMax, prefs.fontSize + 1) })} disabled={prefs.fontSize >= L.fontMax}>
                <Plus size={13} />
              </IconButton>
              <IconButton label="Wrap long lines" pressed={prefs.wrap} onClick={() => setPrefs({ wrap: !prefs.wrap })}>
                <WrapText size={13} />
              </IconButton>
              <IconButton
                label={prefs.focus ? "Leave focus mode" : "Focus mode: hide the problem"}
                pressed={prefs.focus}
                onClick={() => setPrefs({ focus: !prefs.focus })}
              >
                {prefs.focus ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </IconButton>
            </div>
          )}
          {toolbar}
        </div>
      </div>
      <div className={adjustable ? undefined : heightClass} style={adjustable ? { height } : undefined}>
        <Suspense fallback={<PlainEditor value={value} onChange={onChange} readOnly={readOnly} />}>
          <MonacoEditor
            value={value}
            onChange={onChange}
            language={language}
            readOnly={readOnly}
            ariaLabel={label}
            fontSize={adjustable ? prefs.fontSize : 14}
            wrap={adjustable && prefs.wrap}
            markers={markers}
            jump={jump}
          />
        </Suspense>
      </div>
      {adjustable && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the editor"
          aria-valuemin={L.heightMin}
          aria-valuemax={L.heightMax}
          aria-valuenow={Math.round(height)}
          tabIndex={0}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 80 : 20;
            if (e.key === "ArrowUp") setPrefs({ height: Math.max(L.heightMin, prefs.height - step) });
            else if (e.key === "ArrowDown") setPrefs({ height: Math.min(L.heightMax, prefs.height + step) });
            else return;
            e.preventDefault();
          }}
          title="Drag to resize the editor"
          className="group flex h-3 cursor-row-resize touch-none items-center justify-center border-t border-line bg-surface/80"
        >
          <span className={`h-1 w-10 rounded-full ${dragHeight ? "bg-accent" : "bg-line-strong group-hover:bg-accent/70"}`} />
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={`grid h-7 w-7 place-items-center rounded-lg transition disabled:opacity-40 ${
        pressed ? "bg-accent/15 text-accent" : "text-muted hover:bg-sunken hover:text-ink"
      }`}
    >
      {children}
    </button>
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
      className="h-full w-full resize-none bg-paper p-3 font-mono text-sm text-ink outline-none"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
