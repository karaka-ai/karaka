# Karaka browser authentication

`karakaBrowserAuth` verifies application-issued JWTs against explicitly configured SPKI public keys, algorithms, issuer, audience, application identity and token lifetime. It returns the signed tenant/user owner and expiration time. Signing keys remain with the application backend.

The Karaka HTTP transport consumes this service on an explicitly configured browser path. DSH's original Connection implementation remains unchanged.

## Model Experience

JWT verification adds no model context, tokens or tools. Its output authorizes access to application chats.

## Known Limitations and Deferred Work

Browser behavior is outside the selected backend end-to-end validation. The existing DSH browser Connection wire protocol is not implemented by this service or the Karaka HTTP endpoint.
