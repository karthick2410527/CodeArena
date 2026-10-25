import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

/**
 * Problem statements, constraints and editorials: Markdown with TeX math
 * ($n \le 10^5$ inline, $$...$$ on its own line), as competitive programming
 * statements are written.
 */
export default function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore" }]]}>
      {children}
    </ReactMarkdown>
  );
}

/** "Codeforces 4A" / "AtCoder abc300_a" for a source link, else its host. */
export function sourceName(url: string): string {
  try {
    const u = new URL(url);
    const cf = u.pathname.match(/^\/(?:problemset\/problem\/(\d+)\/(\w+)|(?:contest|gym)\/(\d+)\/problem\/(\w+))/);
    if (u.hostname.endsWith("codeforces.com") && cf) return `Codeforces ${cf[1] ?? cf[3]}${(cf[2] ?? cf[4]).toUpperCase()}`;
    const ac = u.pathname.match(/^\/contests\/[^/]+\/tasks\/([^/]+)/);
    if (u.hostname === "atcoder.jp" && ac) return `AtCoder ${ac[1]}`;
    return u.hostname;
  } catch {
    return url;
  }
}
