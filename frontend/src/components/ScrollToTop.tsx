import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Starts each new page at the top, as a browser does for real page loads.
 * Only the path counts: changing a filter in the query string, or a #hash
 * link, keeps the reader where they are.
 */
export default function ScrollToTop() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (!hash) window.scrollTo({ top: 0, left: 0, behavior: "instant" as ScrollBehavior });
  }, [pathname, hash]);
  return null;
}
