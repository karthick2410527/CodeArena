//! `codearena-dlq` — inspect and replay dead-lettered judge jobs.
//!
//! The same operations are available to administrators over HTTP
//! (`GET /api/v1/admin/dead-letters`, `POST …/replay`); this exists for the
//! case where the API itself is the thing that is unhealthy.
//!
//! ```text
//! codearena-dlq list [--all] [--limit N]   # pending (or every) entry
//! codearena-dlq show <id>                  # one entry with its payload
//! codearena-dlq replay <id>                # re-queue it
//! codearena-dlq resolve <id> <note>        # mark handled without replaying
//! ```

use codearena_api::{
    config::Config,
    queue::{outbox, JudgeJob},
};
use sqlx::postgres::PgPoolOptions;
use std::time::Duration;
use uuid::Uuid;

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args[0] == "--help" || args[0] == "-h" {
        print_usage();
        return;
    }

    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("configuration error: {e}");
            std::process::exit(1);
        }
    };
    let pool = match PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&config.database_url)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!("could not connect to PostgreSQL: {e}");
            std::process::exit(1);
        }
    };

    let result = match args[0].as_str() {
        "list" => list(&pool, &args[1..]).await,
        "show" => show(&pool, args.get(1)).await,
        "replay" => replay(&pool, args.get(1)).await,
        "resolve" => resolve(&pool, args.get(1), args.get(2)).await,
        other => {
            eprintln!("unknown command {other:?}\n");
            print_usage();
            std::process::exit(2);
        }
    };
    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn print_usage() {
    println!(
        "codearena-dlq — inspect and replay dead-lettered judge jobs\n\n\
         USAGE:\n\
         \x20 codearena-dlq list [--all] [--limit N]\n\
         \x20 codearena-dlq show <id>\n\
         \x20 codearena-dlq replay <id>\n\
         \x20 codearena-dlq resolve <id> <note>\n"
    );
}

type Res = Result<(), Box<dyn std::error::Error>>;

/// `(id, submission_id, reason, created_at, resolved_at)` — one listing row.
type ListRow = (
    i64,
    Option<Uuid>,
    String,
    chrono::DateTime<chrono::Utc>,
    Option<chrono::DateTime<chrono::Utc>>,
);

/// `(id, submission_id, event_type, reason, payload, resolution)`.
type DetailRow = (
    i64,
    Option<Uuid>,
    String,
    String,
    serde_json::Value,
    Option<String>,
);

async fn list(pool: &sqlx::PgPool, args: &[String]) -> Res {
    let include_resolved = args.iter().any(|a| a == "--all");
    let limit: i64 = args
        .iter()
        .position(|a| a == "--limit")
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(50);

    let rows: Vec<ListRow> = sqlx::query_as(
        "SELECT id, submission_id, reason, created_at, resolved_at \
               FROM dead_letter_events WHERE ($1 OR resolved_at IS NULL) \
              ORDER BY created_at DESC LIMIT $2",
    )
    .bind(include_resolved)
    .bind(limit.clamp(1, 500))
    .fetch_all(pool)
    .await?;

    if rows.is_empty() {
        println!("no dead-lettered jobs");
        return Ok(());
    }
    println!("{:<6} {:<38} {:<20} REASON", "ID", "SUBMISSION", "CREATED");
    for (id, submission, reason, created, resolved) in rows {
        println!(
            "{:<6} {:<38} {:<20} {}{}",
            id,
            submission
                .map(|s| s.to_string())
                .unwrap_or_else(|| "-".into()),
            created.format("%Y-%m-%d %H:%M:%S"),
            reason,
            if resolved.is_some() {
                "  [resolved]"
            } else {
                ""
            }
        );
    }
    Ok(())
}

async fn show(pool: &sqlx::PgPool, id: Option<&String>) -> Res {
    let id: i64 = id.ok_or("usage: codearena-dlq show <id>")?.parse()?;
    let row: Option<DetailRow> = sqlx::query_as(
        "SELECT id, submission_id, event_type, reason, payload, resolution \
               FROM dead_letter_events WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    let (id, submission, event_type, reason, payload, resolution) =
        row.ok_or("no such dead-letter entry")?;
    println!("id:         {id}");
    println!(
        "submission: {}",
        submission
            .map(|s| s.to_string())
            .unwrap_or_else(|| "-".into())
    );
    println!("event:      {event_type}");
    println!("reason:     {reason}");
    if let Some(r) = resolution {
        println!("resolution: {r}");
    }
    println!("payload:    {}", serde_json::to_string_pretty(&payload)?);
    Ok(())
}

async fn replay(pool: &sqlx::PgPool, id: Option<&String>) -> Res {
    let id: i64 = id.ok_or("usage: codearena-dlq replay <id>")?.parse()?;
    let row: Option<(Option<Uuid>, Option<chrono::DateTime<chrono::Utc>>)> =
        sqlx::query_as("SELECT submission_id, resolved_at FROM dead_letter_events WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    let (submission_id, resolved) = row.ok_or("no such dead-letter entry")?;
    if resolved.is_some() {
        return Err("this entry has already been resolved".into());
    }
    let submission_id = submission_id.ok_or("this entry is not attached to a submission")?;

    let meta: Option<(Uuid, Uuid, String, Option<String>)> = sqlx::query_as(
        "SELECT problem_id, user_id, language, correlation_id FROM submissions WHERE id = $1",
    )
    .bind(submission_id)
    .fetch_optional(pool)
    .await?;
    let (problem_id, user_id, language, correlation_id) =
        meta.ok_or("the submission no longer exists")?;

    let mut tx = pool.begin().await?;
    sqlx::query(
        "UPDATE submissions \
            SET status = 'QUEUED', verdict = NULL, internal_error = NULL, finished_at = NULL, \
                attempts = 0, claimed_by = NULL, claimed_at = NULL \
          WHERE id = $1",
    )
    .bind(submission_id)
    .execute(&mut *tx)
    .await?;
    let job = JudgeJob {
        submission_id,
        problem_id,
        user_id,
        language,
        correlation_id,
        enqueued_at: chrono::Utc::now(),
    };
    outbox::enqueue(&mut tx, &job).await?;
    sqlx::query(
        "UPDATE dead_letter_events SET resolved_at = now(), resolution = 'replayed via CLI' \
          WHERE id = $1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    println!("submission {submission_id} re-queued");
    Ok(())
}

async fn resolve(pool: &sqlx::PgPool, id: Option<&String>, note: Option<&String>) -> Res {
    let id: i64 = id
        .ok_or("usage: codearena-dlq resolve <id> <note>")?
        .parse()?;
    let note = note.ok_or("usage: codearena-dlq resolve <id> <note>")?;
    let affected = sqlx::query(
        "UPDATE dead_letter_events SET resolved_at = now(), resolution = $2 \
          WHERE id = $1 AND resolved_at IS NULL",
    )
    .bind(id)
    .bind(note)
    .execute(pool)
    .await?
    .rows_affected();
    if affected == 0 {
        return Err("no such pending dead-letter entry".into());
    }
    println!("entry {id} marked resolved");
    Ok(())
}
