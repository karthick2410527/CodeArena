//! Judge states, verdicts and the rules for moving between them.
//!
//! Kafka delivers at least once and workers can die mid-job, so state changes
//! must be *guarded*: a transition is only legal from a known set of previous
//! states, and a submission that already has a verdict is never overwritten.
//! [`JudgeStatus::can_transition_to`] is the single definition of that rule and
//! is mirrored by a `CHECK`-protected `UPDATE … WHERE status = …` in SQL.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Lifecycle of a submission row. Stored in `submissions.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum JudgeStatus {
    /// Persisted, waiting for a worker.
    Queued,
    /// A worker has claimed it.
    Running,
    /// Judging finished; `submissions.verdict` holds the outcome.
    Finished,
}

impl JudgeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "QUEUED",
            Self::Running => "RUNNING",
            Self::Finished => "FINISHED",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "QUEUED" => Some(Self::Queued),
            "RUNNING" => Some(Self::Running),
            "FINISHED" => Some(Self::Finished),
            _ => None,
        }
    }

    pub fn is_terminal(self) -> bool {
        self == Self::Finished
    }

    /// The guard. `Finished` is final: a duplicate Kafka delivery that tries to
    /// re-judge a finished submission is refused here, which is what keeps
    /// repeated delivery from producing conflicting results.
    pub fn can_transition_to(self, next: Self) -> bool {
        match (self, next) {
            // A worker may re-claim a submission it already claimed (retry
            // after a transient failure, or a redelivered message).
            (Self::Queued, Self::Running) | (Self::Running, Self::Running) => true,
            (Self::Queued, Self::Finished) | (Self::Running, Self::Finished) => true,
            // A finished submission never changes again.
            (Self::Finished, _) => false,
            (Self::Running, Self::Queued) => true, // requeued after a crash
            _ => false,
        }
    }
}

impl fmt::Display for JudgeStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The outcome of judging. Stored in `submissions.verdict` and
/// `submission_results.verdict`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Verdict {
    Accepted,
    WrongAnswer,
    CompilationError,
    RuntimeError,
    TimeLimitExceeded,
    MemoryLimitExceeded,
    /// Judge infrastructure failed after the configured number of attempts.
    InternalError,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "ACCEPTED",
            Self::WrongAnswer => "WRONG_ANSWER",
            Self::CompilationError => "COMPILATION_ERROR",
            Self::RuntimeError => "RUNTIME_ERROR",
            Self::TimeLimitExceeded => "TIME_LIMIT_EXCEEDED",
            Self::MemoryLimitExceeded => "MEMORY_LIMIT_EXCEEDED",
            Self::InternalError => "INTERNAL_ERROR",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ACCEPTED" => Some(Self::Accepted),
            "WRONG_ANSWER" => Some(Self::WrongAnswer),
            "COMPILATION_ERROR" => Some(Self::CompilationError),
            "RUNTIME_ERROR" => Some(Self::RuntimeError),
            "TIME_LIMIT_EXCEEDED" => Some(Self::TimeLimitExceeded),
            "MEMORY_LIMIT_EXCEEDED" => Some(Self::MemoryLimitExceeded),
            "INTERNAL_ERROR" => Some(Self::InternalError),
            _ => None,
        }
    }

    /// Every verdict a client may filter submission history by.
    pub const ALL: &'static [Verdict] = &[
        Verdict::Accepted,
        Verdict::WrongAnswer,
        Verdict::CompilationError,
        Verdict::RuntimeError,
        Verdict::TimeLimitExceeded,
        Verdict::MemoryLimitExceeded,
        Verdict::InternalError,
    ];

    pub fn is_accepted(self) -> bool {
        self == Self::Accepted
    }

    /// Maps a failed execution onto the verdict it produces.
    pub fn from_exec_status(status: crate::runner::ExecStatus) -> Self {
        use crate::runner::ExecStatus::*;
        match status {
            Ok => Self::Accepted,
            NonZeroExit | Signalled => Self::RuntimeError,
            TimeLimit => Self::TimeLimitExceeded,
            MemoryLimit => Self::MemoryLimitExceeded,
            // Too much output is the program's fault, not the judge's.
            OutputLimit => Self::RuntimeError,
        }
    }
}

impl fmt::Display for Verdict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What a client sees while polling: the lifecycle state until judging ends,
/// then the verdict. This is the flattened vocabulary in the project
/// specification's verdict table.
pub fn public_status(status: JudgeStatus, verdict: Option<Verdict>) -> String {
    match (status, verdict) {
        (JudgeStatus::Finished, Some(v)) => v.as_str().to_string(),
        // A finished row with no verdict would be a bug; report it honestly
        // rather than claiming success.
        (JudgeStatus::Finished, None) => Verdict::InternalError.as_str().to_string(),
        (s, _) => s.as_str().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::ExecStatus;

    #[test]
    fn status_round_trips() {
        for s in [
            JudgeStatus::Queued,
            JudgeStatus::Running,
            JudgeStatus::Finished,
        ] {
            assert_eq!(JudgeStatus::parse(s.as_str()), Some(s));
        }
        assert_eq!(JudgeStatus::parse("NOPE"), None);
    }

    #[test]
    fn verdict_round_trips() {
        for v in Verdict::ALL {
            assert_eq!(Verdict::parse(v.as_str()), Some(*v));
        }
        assert_eq!(Verdict::parse("ALMOST_RIGHT"), None);
    }

    #[test]
    fn a_finished_submission_is_never_re_judged() {
        for next in [
            JudgeStatus::Queued,
            JudgeStatus::Running,
            JudgeStatus::Finished,
        ] {
            assert!(
                !JudgeStatus::Finished.can_transition_to(next),
                "FINISHED must not move to {next}"
            );
        }
    }

    #[test]
    fn duplicate_claim_is_allowed() {
        // The same worker re-reading a redelivered message must not deadlock.
        assert!(JudgeStatus::Running.can_transition_to(JudgeStatus::Running));
        assert!(JudgeStatus::Queued.can_transition_to(JudgeStatus::Running));
    }

    #[test]
    fn crashed_worker_can_requeue() {
        assert!(JudgeStatus::Running.can_transition_to(JudgeStatus::Queued));
        assert!(!JudgeStatus::Queued.can_transition_to(JudgeStatus::Queued));
    }

    #[test]
    fn both_states_can_finish() {
        assert!(JudgeStatus::Queued.can_transition_to(JudgeStatus::Finished));
        assert!(JudgeStatus::Running.can_transition_to(JudgeStatus::Finished));
    }

    #[test]
    fn exec_status_maps_to_verdicts() {
        assert_eq!(Verdict::from_exec_status(ExecStatus::Ok), Verdict::Accepted);
        assert_eq!(
            Verdict::from_exec_status(ExecStatus::TimeLimit),
            Verdict::TimeLimitExceeded
        );
        assert_eq!(
            Verdict::from_exec_status(ExecStatus::MemoryLimit),
            Verdict::MemoryLimitExceeded
        );
        assert_eq!(
            Verdict::from_exec_status(ExecStatus::Signalled),
            Verdict::RuntimeError
        );
        assert_eq!(
            Verdict::from_exec_status(ExecStatus::NonZeroExit),
            Verdict::RuntimeError
        );
        assert_eq!(
            Verdict::from_exec_status(ExecStatus::OutputLimit),
            Verdict::RuntimeError
        );
    }

    #[test]
    fn public_status_flattens_lifecycle_and_verdict() {
        assert_eq!(public_status(JudgeStatus::Queued, None), "QUEUED");
        assert_eq!(public_status(JudgeStatus::Running, None), "RUNNING");
        assert_eq!(
            public_status(JudgeStatus::Finished, Some(Verdict::Accepted)),
            "ACCEPTED"
        );
        assert_eq!(public_status(JudgeStatus::Finished, None), "INTERNAL_ERROR");
    }
}
