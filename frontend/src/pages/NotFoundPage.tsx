import { Link } from "react-router-dom";
import { EmptyState } from "../components/Feedback";

export default function NotFoundPage() {
  return (
    <EmptyState
      title="Page not found"
      message="The page you're looking for doesn't exist."
      action={
        <Link to="/problems" className="btn btn-primary">
          Browse problems
        </Link>
      }
    />
  );
}
