import { Navigate, Outlet, useLocation, useOutletContext } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { Spinner } from "../components/Feedback";

/** Renders child routes only for authenticated users; otherwise redirects to /login. */
export default function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();
  // A guard nested inside another route (a contest's Submissions tab) must hand
  // that route's outlet context on to its own children, or they lose it.
  const parent = useOutletContext();

  if (status === "loading") return <Spinner label="Restoring your session…" />;
  if (status === "anonymous") {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet context={parent} />;
}
