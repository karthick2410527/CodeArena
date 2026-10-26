/**
 * Monaco, configured to load from the bundle rather than a CDN.
 *
 * `@monaco-editor/react` fetches Monaco from jsdelivr by default, which would
 * make the editor fail without internet access. Pointing `loader` at the
 * locally installed `monaco-editor` keeps the app self-contained.
 *
 * Tests alias both packages to lightweight stubs (see `vite.config.ts`), so the
 * suite never has to transform the real 3 MB bundle.
 */
import { useEffect, useRef } from "react";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
// Importing `monaco-editor` wholesale pulls every language and language
// service into the bundle (~3.3 MB). The editor API plus the grammars of the
// three judged languages is a fraction of that.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { useDisplay, type ThemeName } from "../display";

// Only grammars are loaded, no language services, so the base editor worker
// covers tokenising, folding and the rest.
self.MonacoEnvironment = { getWorker: () => new editorWorker() };
loader.config({ monaco });

/** Editor theme per app theme, so the editor never looks pasted in. */
const EDITOR_THEME: Record<ThemeName, string> = {
  light: "voidrun-light",
  sand: "voidrun-sand",
  dark: "voidrun-dark",
  midnight: "voidrun-midnight",
  emerald: "voidrun-emerald",
};
let themesDefined = false;

type Palette = {
  base: "vs" | "vs-dark";
  background: string;
  highlight: string;
  lineNumber: string;
  activeLineNumber: string;
  guide: string;
  keyword: string;
  comment: string;
  number: string;
  string: string;
  type: string;
};

const PALETTES: Record<string, Palette> = {
  "voidrun-light": { base: "vs", background: "#fdfdfb", highlight: "#eeede680", lineNumber: "#9ca3af",
    activeLineNumber: "#15171c", guide: "#dddcd3", keyword: "3a2bea", comment: "6b7280", number: "9a6a00",
    string: "2e7d4f", type: "1d4ed8" },
  "voidrun-sand": { base: "vs", background: "#fbf8f2", highlight: "#ece5d780", lineNumber: "#a59a86",
    activeLineNumber: "#211d18", guide: "#ded4c2", keyword: "ba400e", comment: "7c7262", number: "925c06",
    string: "1f763e", type: "1e4f9c" },
  "voidrun-dark": { base: "vs-dark", background: "#16181e", highlight: "#21242c", lineNumber: "#5a6070",
    activeLineNumber: "#eceef3", guide: "#2d313b", keyword: "a59dff", comment: "7d8494", number: "e8b440",
    string: "7fd8a4", type: "7cc4ff" },
  "voidrun-midnight": { base: "vs-dark", background: "#0c1426", highlight: "#15213a", lineNumber: "#4f6288",
    activeLineNumber: "#e5edfa", guide: "#202f4e", keyword: "38bdf8", comment: "7889ab", number: "fbbf24",
    string: "6ee7b7", type: "c4b5fd" },
  "voidrun-emerald": { base: "vs", background: "#fdfdfc", highlight: "#eeefeb80", lineNumber: "#9ca3af",
    activeLineNumber: "#14181a", guide: "#ddded8", keyword: "16804a", comment: "6b7280", number: "9a6a00",
    string: "0f766e", type: "1d4ed8" },
};

function defineThemes(instance: typeof monaco) {
  if (themesDefined) return;
  themesDefined = true;
  for (const [name, p] of Object.entries(PALETTES)) {
    instance.editor.defineTheme(name, {
      base: p.base,
      inherit: true,
      rules: [
        { token: "comment", foreground: p.comment, fontStyle: "italic" },
        { token: "keyword", foreground: p.keyword },
        { token: "number", foreground: p.number },
        { token: "string", foreground: p.string },
        { token: "type", foreground: p.type },
      ],
      colors: {
        "editor.background": p.background,
        "editor.lineHighlightBackground": p.highlight,
        "editorLineNumber.foreground": p.lineNumber,
        "editorLineNumber.activeForeground": p.activeLineNumber,
        "editorGutter.background": p.background,
        "editorIndentGuide.background1": p.guide,
      },
    });
  }
}

export interface MonacoEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Monaco language id, e.g. `"cpp"`. */
  language: string;
  readOnly?: boolean;
  ariaLabel?: string;
  fontSize?: number;
  wrap?: boolean;
  /** Compiler diagnostics, drawn as squiggles with hover messages. */
  markers?: EditorMarker[];
  /** Scrolls to and selects this line; a new object jumps again to the same line. */
  jump?: { line: number; column?: number } | null;
}

export interface EditorMarker {
  line: number;
  column?: number;
  message: string;
  severity: "error" | "warning" | "note";
}

export default function MonacoEditor({
  value,
  onChange,
  language,
  readOnly,
  ariaLabel,
  fontSize = 14,
  wrap = false,
  markers,
  jump,
}: MonacoEditorProps) {
  const [display] = useDisplay();
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    applyMarkers(editor, markers);
  };
  useEffect(() => applyMarkers(editorRef.current, markers), [markers, value]);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !jump) return;
    const column = jump.column ?? 1;
    editor.revealLineInCenter(jump.line);
    editor.setSelection({ startLineNumber: jump.line, startColumn: column, endLineNumber: jump.line, endColumn: column });
    editor.focus();
  }, [jump]);
  return (
    <Editor
      onMount={onMount}
      value={value}
      language={language}
      theme={EDITOR_THEME[display.theme]}
      beforeMount={defineThemes}
      onChange={(next) => onChange(next ?? "")}
      loading={<div className="p-4 text-sm text-muted">Loading editor…</div>}
      options={{
        readOnly,
        ariaLabel,
        fontSize,
        wordWrap: wrap ? "on" : "off",
        fontFamily:
          '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 4,
        insertSpaces: true,
        renderLineHighlight: "line",
        smoothScrolling: true,
        padding: { top: 12, bottom: 12 },
        bracketPairColorization: { enabled: true },
        // Suggestions for a language with no type information are noise.
        quickSuggestions: false,
        wordBasedSuggestions: "currentDocument",
      }}
    />
  );
}

const SEVERITY = { error: 8, warning: 4, note: 2 } as const; // monaco.MarkerSeverity

function applyMarkers(editor: Parameters<OnMount>[0] | null, markers: EditorMarker[] | undefined) {
  const model = editor?.getModel();
  if (!model) return;
  monaco.editor.setModelMarkers(
    model,
    "voidrun",
    (markers ?? [])
      .filter((m) => m.line >= 1 && m.line <= model.getLineCount())
      .map((m) => {
        const startColumn = m.column ?? model.getLineFirstNonWhitespaceColumn(m.line) ?? 1;
        // Underline the word at the column, or the rest of the line without one.
        const word = m.column ? model.getWordAtPosition({ lineNumber: m.line, column: m.column }) : null;
        return {
          severity: SEVERITY[m.severity],
          message: m.message,
          startLineNumber: m.line,
          startColumn,
          endLineNumber: m.line,
          endColumn: word ? word.endColumn : model.getLineMaxColumn(m.line),
        };
      }),
  );
}
