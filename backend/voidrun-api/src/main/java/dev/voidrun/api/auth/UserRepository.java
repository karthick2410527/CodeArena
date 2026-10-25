package dev.voidrun.api.auth;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class UserRepository {

    static final String COLUMNS =
            "id, username, email, email_verified, password_hash, display_name, avatar_url, role, created_at";

    static final RowMapper<UserRow> MAPPER = UserRepository::map;

    private final JdbcClient jdbc;

    public UserRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<UserRow> findById(UUID id) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM users WHERE id = ?").param(id).query(MAPPER).optional();
    }

    public Optional<UserRow> findByEmail(String email) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM users WHERE lower(email) = lower(?)")
                .param(email)
                .query(MAPPER)
                .optional();
    }

    public boolean usernameTaken(String username) {
        return jdbc.sql("SELECT EXISTS (SELECT 1 FROM users WHERE lower(username) = lower(?))")
                .param(username)
                .query(Boolean.class)
                .single();
    }

    /** Inserts a user; throws {@link org.springframework.dao.DuplicateKeyException} on a taken username or email. */
    public UserRow insert(String username, String email, boolean emailVerified, String passwordHash,
            String displayName, String avatarUrl) {
        return jdbc.sql("""
                        INSERT INTO users (username, email, email_verified, password_hash, display_name, avatar_url)
                        VALUES (?, ?, ?, ?, ?, ?)
                        RETURNING\s""" + COLUMNS)
                .params(username, email, emailVerified, passwordHash, displayName, avatarUrl)
                .query(MAPPER)
                .single();
    }

    public static UserRow map(ResultSet rs, int row) throws SQLException {
        return new UserRow(
                rs.getObject("id", UUID.class),
                rs.getString("username"),
                rs.getString("email"),
                rs.getBoolean("email_verified"),
                rs.getString("password_hash"),
                rs.getString("display_name"),
                rs.getString("avatar_url"),
                rs.getString("role"),
                rs.getTimestamp("created_at").toInstant());
    }
}
