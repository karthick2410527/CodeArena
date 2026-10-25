import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../api/client";
import { contestsApi } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { EmptyState, ErrorState, Spinner } from "../../components/Feedback";
import SplitPane from "../../components/SplitPane";
import Workspace from "../../components/Workspace";
import { Notice } from "../../components/ui";
import { ProblemStatement } from "../ProblemDetailPage";
import { useContest } from "./ContestPage";

/**
 * The arena: one contest problem beside the editor, under the contest bar.
 * Submit goes through the contest, so while it runs and you are registered,
 * the submission counts for the standings.
 */
export default function ContestProblemPage() {
  const { label = "" } = useParams();
  const { d, phase } = useContest();
  const { status } = useAuth();
  const c = d.contest;
  const problem = useQuery({
    queryKey: ["contest-problem", c.slug, label],
    queryFn: ({ signal }) => contestsApi.problem(c.slug, label, signal),
  });

  if (problem.isPending) return <Spinner label="Loading the problem…" />;
  if (problem.isError) {
    if (problem.error instanceof ApiError && problem.error.status === 404) {
      return (
        <EmptyState
          title="Problem not available"
          message="Contest problems appear when the contest starts."
          action={
            <Link to={`/contests/${c.slug}`} className="btn btn-primary">
              Back to the contest
            </Link>
          }
        />
      );
    }
    return <ErrorState title="Couldn't load the problem" message={problem.error.message} onRetry={() => problem.refetch()} />;
  }

  const counts = phase === "RUNNING" && c.registered;
  const p = problem.data;
  return (
    <div className="space-y-4">
      {status === "authenticated" && !counts && !c.my_role && phase !== "ENDED" && (
        <Notice tone="warn">
          {phase === "UPCOMING" ? "The contest has not started yet." : "Register for the contest to submit; you can still run your code."}
        </Notice>
      )}
      {phase === "ENDED" && <Notice>The contest has ended. Submissions now are practice and do not change the standings.</Notice>}
      {c.my_role && <Notice>You are an author: your submissions here are tests and never appear in the standings.</Notice>}
      <SplitPane
        left={
          <div>
            {c.format !== "ICPC" && <p className="mb-2 text-xs text-faint">{p.points} points</p>}
            <ProblemStatement problem={p.problem} prefix={`${p.label}.`} />
          </div>
        }
        right={
          <Workspace
            problem={p.problem}
            submitLabel={counts ? "Submit to contest" : "Submit"}
            submit={({ language, source }) => contestsApi.submit(c.slug, { label: p.label, language, source_code: source })}
          />
        }
      />
    </div>
  );
}
