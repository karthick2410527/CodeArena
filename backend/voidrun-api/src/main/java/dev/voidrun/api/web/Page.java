package dev.voidrun.api.web;

import java.util.List;

/**
 * The envelope every paginated endpoint returns. {@code limit} is capped, so
 * no endpoint can be asked for an unbounded number of rows.
 */
public record Page<T>(List<T> items, int page, int limit, long total, long totalPages) {

    public static final int DEFAULT_LIMIT = 20;
    public static final int MAX_LIMIT = 50;

    /** Validated page and limit from query parameters. */
    public record Request(int page, int limit) {

        public static Request of(Integer page, Integer limit) {
            int p = page == null ? 1 : page;
            int l = limit == null ? DEFAULT_LIMIT : limit;
            if (p < 1) {
                throw ApiException.badRequest("page must be at least 1");
            }
            if (l < 1 || l > MAX_LIMIT) {
                throw ApiException.badRequest("limit must be between 1 and " + MAX_LIMIT);
            }
            return new Request(p, l);
        }

        public long offset() {
            return (long) (page - 1) * limit;
        }

        public <T> Page<T> wrap(List<T> items, long total) {
            return new Page<>(items, page, limit, total, total == 0 ? 0 : (total + limit - 1) / limit);
        }
    }
}
