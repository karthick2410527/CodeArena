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
import Editor, { loader } from "@monaco-editor/react";
// Importing `monaco-editor` wholesale pulls every language and language
// service into the bundle (~3.3 MB). The editor API plus the one grammar this
// app uses is a third of that.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// C++ has no dedicated language service worker in Monaco; the base editor
// worker covers tokenising, folding and the rest.
self.MonacoEnvironment = { getWorker: () => new editorWorker() };
loader.config({ monaco });

const THEME = "codearena-dark";
let themeDefined = false;

function defineTheme(instance: typeof monaco) {
  if (themeDefined) return;
  themeDefined = true;
  // Matches the app's slate/indigo palette so the editor does not look pasted in.
  instance.editor.defineTheme(THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "64748b", fontStyle: "italic" },
      { token: "keyword", foreground: "a5b4fc" },
      { token: "number", foreground: "fbbf24" },
      { token: "string", foreground: "6ee7b7" },
      { token: "type", foreground: "7dd3fc" },
    ],
    colors: {
      "editor.background": "#0b1120",
      "editor.lineHighlightBackground": "#1e293b66",
      "editorLineNumber.foreground": "#475569",
      "editorLineNumber.activeForeground": "#cbd5e1",
      "editorGutter.background": "#0b1120",
      "editorIndentGuide.background1": "#1e293b",
    },
  });
}

export interface MonacoEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Monaco language id, e.g. `"cpp"`. */
  language: string;
  readOnly?: boolean;
  ariaLabel?: string;
}

export default function MonacoEditor({
  value,
  onChange,
  language,
  readOnly,
  ariaLabel,
}: MonacoEditorProps) {
  return (
    <Editor
      value={value}
      language={language}
      theme={THEME}
      beforeMount={defineTheme}
      onChange={(next) => onChange(next ?? "")}
      loading={<div className="p-4 text-sm text-slate-400">Loading editor…</div>}
      options={{
        readOnly,
        ariaLabel,
        fontSize: 14,
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
