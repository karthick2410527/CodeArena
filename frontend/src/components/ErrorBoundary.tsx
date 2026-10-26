import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";

/**
 * Catches a crash while rendering a page, so the rest of the app (the top bar,
 * the way back) keeps working and the reader sees what happened instead of a
 * blank screen. Keyed by the page's path by its parent, so it resets on navigation.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("page crashed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="mx-auto max-w-lg py-16 text-center">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-bad/10 text-bad">
          <AlertTriangle size={24} aria-hidden="true" />
        </span>
        <h1 className="mt-5 font-display text-2xl font-semibold text-ink">This page ran into a problem</h1>
        <p className="mt-2 text-sm text-muted">
          Something went wrong while showing it. Try again, or go back to where you were.
        </p>
        <pre className="mx-auto mt-4 max-w-full overflow-x-auto rounded-xl bg-sunken/70 px-3 py-2 text-left font-mono text-xs text-faint">
          {this.state.error.message}
        </pre>
        <div className="mt-6 flex justify-center gap-2">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload the page
          </button>
          <Link to="/" className="btn btn-outline" onClick={() => this.setState({ error: null })}>
            Go home
          </Link>
        </div>
      </div>
    );
  }
}
