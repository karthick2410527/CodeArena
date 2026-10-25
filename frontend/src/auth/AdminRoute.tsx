import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { EmptyState, Spinner } from "../components/Feedback";

/**
 * Renders child routes only for administrators.
 *
 * This hides the UI; it is not the security boundary. Every admin endpoint
 * re-checks the role against the database on each request, so a user who
 * navigates here by hand still gets a 403 from the API.
 */
export default function AdminRoute() {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === "loading") return <Spinner label="Checking your access…" />;
  if (status === "anonymous") {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (user?.role !== "ADMIN") {
    return (
      <EmptyState
        title="Administrators only"
        message="Your account doesn't have access to this area."
      />
    );
  }
  return <Outlet />;
}
