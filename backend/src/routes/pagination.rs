//! Shared, bounded pagination.
//!
//! Every list endpoint goes through this: there is no code path that can read
//! an unbounded number of rows, because `limit` is validated against a ceiling
//! before it ever reaches SQL.

use crate::error::{AppError, AppResult};
use serde::Serialize;

pub const DEFAULT_LIMIT: u32 = 20;
pub const MAX_LIMIT: u32 = 50;

/// Validated page/limit pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Page {
    pub page: u32,
    pub limit: u32,
}

impl Page {
    /// Validates client-supplied values. Rejects rather than silently clamping,
    /// so a caller asking for 10 000 rows learns that it will not happen.
    pub fn new(page: Option<u32>, limit: Option<u32>) -> AppResult<Self> {
        let page = page.unwrap_or(1);
        let limit = limit.unwrap_or(DEFAULT_LIMIT);
        if page < 1 {
            return Err(AppError::BadRequest("page must be >= 1".into()));
        }
        // An absurd page number would make the OFFSET overflow.
        if page > 100_000 {
            return Err(AppError::BadRequest("page must be <= 100000".into()));
        }
        if !(1..=MAX_LIMIT).contains(&limit) {
            return Err(AppError::BadRequest(format!(
                "limit must be between 1 and {MAX_LIMIT}"
            )));
        }
        Ok(Self { page, limit })
    }

    pub fn offset(self) -> i64 {
        (self.page as i64 - 1) * self.limit as i64
    }

    pub fn limit_i64(self) -> i64 {
        self.limit as i64
    }

    pub fn total_pages(self, total: i64) -> u32 {
        if total <= 0 {
            return 0;
        }
        ((total + self.limit as i64 - 1) / self.limit as i64) as u32
    }
}

/// The envelope every paginated endpoint returns.
#[derive(Debug, Serialize)]
pub struct Paginated<T> {
    pub items: Vec<T>,
    pub page: u32,
    pub limit: u32,
    pub total: i64,
    pub total_pages: u32,
}

impl<T> Paginated<T> {
    pub fn new(items: Vec<T>, page: Page, total: i64) -> Self {
        Self {
            items,
            page: page.page,
            limit: page.limit,
            total,
            total_pages: page.total_pages(total),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_applied() {
        let p = Page::new(None, None).unwrap();
        assert_eq!(p.page, 1);
        assert_eq!(p.limit, DEFAULT_LIMIT);
        assert_eq!(p.offset(), 0);
    }

    #[test]
    fn offsets_are_computed_from_the_page() {
        let p = Page::new(Some(3), Some(10)).unwrap();
        assert_eq!(p.offset(), 20);
        assert_eq!(p.limit_i64(), 10);
    }

    #[test]
    fn unbounded_reads_are_impossible() {
        assert!(Page::new(Some(1), Some(MAX_LIMIT + 1)).is_err());
        assert!(Page::new(Some(1), Some(10_000)).is_err());
        assert!(Page::new(Some(1), Some(0)).is_err());
        assert!(Page::new(Some(1), Some(MAX_LIMIT)).is_ok());
    }

    #[test]
    fn nonsensical_pages_are_rejected() {
        assert!(Page::new(Some(0), None).is_err());
        assert!(Page::new(Some(100_001), None).is_err());
    }

    #[test]
    fn total_pages_rounds_up() {
        let p = Page::new(Some(1), Some(8)).unwrap();
        assert_eq!(p.total_pages(0), 0);
        assert_eq!(p.total_pages(1), 1);
        assert_eq!(p.total_pages(8), 1);
        assert_eq!(p.total_pages(9), 2);
        assert_eq!(p.total_pages(16), 2);
    }

    #[test]
    fn envelope_carries_the_page_it_was_built_with() {
        let p = Page::new(Some(2), Some(5)).unwrap();
        let env = Paginated::new(vec![1, 2, 3], p, 13);
        assert_eq!(env.page, 2);
        assert_eq!(env.limit, 5);
        assert_eq!(env.total, 13);
        assert_eq!(env.total_pages, 3);
    }
}
