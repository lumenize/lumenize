# @lumenize/nebula-auth

Multi-tenant authentication for Nebula — magic link login, JWT access tokens, and admin roles scoped to a three-tier hierarchy: Universe > Galaxy > Star.

## Key Features

- Two Durable Object classes: `NebulaAuth` (per-instance auth) and `NebulaAuthRegistry` (singleton central index)
- Magic link login with path-scoped refresh cookies (Coach Carol multi-session support)
- JWT access tokens with wildcard scope matching for admin hierarchy
- Self-signup flows for universe and star creation
- Email-based discovery across all scopes

## License

BSL-1.1
