use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid,
    pub role: String,
    pub iat: i64,
    pub exp: i64,
}

pub fn issue_access_token(
    secret: &str,
    user_id: Uuid,
    role: &str,
    ttl_secs: i64,
) -> Result<String, String> {
    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        sub: user_id,
        role: role.to_string(),
        iat: now,
        exp: now + ttl_secs,
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| e.to_string())
}

pub fn verify_access_token(secret: &str, token: &str) -> Result<Claims, String> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 0;
    validation.set_required_spec_claims(&["exp", "sub"]);
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map(|d| d.claims)
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn roundtrip() {
        let id = Uuid::new_v4();
        let t = issue_access_token(SECRET, id, "USER", 60).unwrap();
        let c = verify_access_token(SECRET, &t).unwrap();
        assert_eq!(c.sub, id);
        assert_eq!(c.role, "USER");
    }

    #[test]
    fn rejects_wrong_secret_and_expired() {
        let id = Uuid::new_v4();
        let t = issue_access_token(SECRET, id, "USER", 60).unwrap();
        assert!(verify_access_token("another-secret-another-secret-123", &t).is_err());
        let expired = issue_access_token(SECRET, id, "USER", -10).unwrap();
        assert!(verify_access_token(SECRET, &expired).is_err());
    }
}
