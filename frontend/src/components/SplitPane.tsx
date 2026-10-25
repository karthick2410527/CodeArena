import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { PanelLeftOpen } from "lucide-react";
import { EDITOR_LIMITS, useEditorPrefs } from "../editorPrefs";

/**
 * Problem statement beside the editor, with a divider to drag (or move with
 * the arrow keys; double-click resets it). Below the large breakpoint the two
 * stack. In focus mode the statement folds away and the editor takes the width.
 */
export default function SplitPane({ left, right }: { left: ReactNode; right: ReactNode }) {
  const [prefs, setPrefs] = useEditorPrefs();
  const box = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const split = dragging ?? prefs.split;
  const { splitMin, splitMax } = EDITOR_LIMITS;

  const at = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    return Math.min(splitMax, Math.max(splitMin, ((clientX - r.left) / r.width) * 100));
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(at(e.clientX));
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging !== null) setDragging(at(e.clientX));
  };
  const onUp = () => {
    if (dragging !== null) setPrefs({ split: Math.round(dragging) });
    setDragging(null);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === "ArrowLeft") setPrefs({ split: Math.max(splitMin, prefs.split - step) });
    else if (e.key === "ArrowRight") setPrefs({ split: Math.min(splitMax, prefs.split + step) });
    else if (e.key === "Home") setPrefs({ split: 50 });
    else return;
    e.preventDefault();
  };

  if (prefs.focus) {
    return (
      <div className="space-y-3">
        <button type="button" className="btn btn-outline min-h-[34px] px-3 text-xs" onClick={() => setPrefs({ focus: false })}>
          <PanelLeftOpen size={15} aria-hidden="true" /> Show the problem
        </button>
        {right}
      </div>
    );
  }

  return (
    <div
      ref={box}
      className={`flex flex-col gap-6 lg:grid lg:items-start lg:gap-0 ${dragging !== null ? "select-none" : ""}`}
      style={{ gridTemplateColumns: `minmax(0, ${split}fr) 1.25rem minmax(0, ${100 - split}fr)` }}
    >
      <div className="min-w-0">{left}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the problem and the editor"
        aria-valuemin={splitMin}
        aria-valuemax={splitMax}
        aria-valuenow={Math.round(split)}
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => setPrefs({ split: 50 })}
        onKeyDown={onKey}
        title="Drag to resize · double-click to reset"
        className="group sticky top-20 hidden h-[calc(100vh-7rem)] cursor-col-resize touch-none justify-center lg:flex"
      >
        <span
          className={`my-auto h-16 w-1 rounded-full transition-colors ${
            dragging !== null ? "bg-accent" : "bg-line-strong group-hover:bg-accent/70 group-focus-visible:bg-accent"
          }`}
        />
      </div>
      <div className="min-w-0 lg:sticky lg:top-20">{right}</div>
    </div>
  );
}
