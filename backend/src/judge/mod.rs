//! The judge: everything that decides what a program's output means.
//!
//! * [`verdict`] — states, verdicts and the guarded transitions between them.
//! * [`compare`] — the output comparison policy.
//! * [`runs`] — the Phase 2 Run pipeline (public samples / custom input).
//! * [`submissions`] — the Phase 3 asynchronous judge (hidden tests).
//!
//! All of it executes in the worker process. The API imports only the types.

pub mod compare;
pub mod runs;
pub mod submissions;
pub mod verdict;

pub use verdict::{public_status, JudgeStatus, Verdict};
