# Security notes

This repository is a reference demo, **not a production-ready hosted service**.

## Local-only by default

- Keep `LLM_API_KEY` in a server-side environment variable or an ignored `.env` file. Never put credentials in frontend code.
- The static server serves only a small explicit allowlist of demo assets; URLs such as `/.env`, `/server.js`, and `/package.json` must return 404.
- Do not expose the demo `/api/chat` endpoint to unauthenticated Internet traffic. Before a public deployment, add authentication, per-user quotas, rate limiting, request validation, session lifecycle/expiry, abuse monitoring, and billing safeguards.
- Generated form HTML is untrusted. The demo uses a sandboxed iframe; keep sandbox restrictions, strengthen HTML sanitization and Content Security Policy before integrating with third-party sites.
- The current prototype does not provide a production security guarantee.

## Reporting

Please open a GitHub issue for non-sensitive bugs. For vulnerabilities involving secrets, do not publish credentials or exploitation details in a public issue; contact the repository owner privately through GitHub.
