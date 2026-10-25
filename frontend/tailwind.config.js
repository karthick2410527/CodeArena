/** @type {import('tailwindcss').Config} */
// Colours are theme tokens (see src/index.css): each is an RGB triple in a CSS
// variable, so the light, low-glare and high-contrast themes swap them and
// Tailwind's opacity modifiers (bg-accent/10) still work.
const c = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: c("paper"),
        surface: c("surface"),
        field: c("field"),
        sunken: c("sunken"),
        line: c("line"),
        "line-strong": c("line-strong"),
        faint: c("faint"),
        muted: c("muted"),
        ink: c("ink"),
        accent: { DEFAULT: c("accent"), hover: c("accent-hover") },
        "accent-ink": c("accent-ink"),
        good: c("good"),
        warn: c("warn"),
        bad: c("bad"),
      },
      fontFamily: {
        display: ["'Space Grotesk'", "'Inter'", "system-ui", "sans-serif"],
        sans: ["'Inter'", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "'SF Mono'", "Menlo", "monospace"],
      },
      boxShadow: {
        panel:
          "0 1px 0 rgb(255 255 255 / var(--panel-shine)) inset, 0 1px 2px rgb(0 0 0 / var(--panel-shadow-1)), 0 8px 20px -14px rgb(0 0 0 / var(--panel-shadow-2))",
      },
    },
  },
  plugins: [],
};
