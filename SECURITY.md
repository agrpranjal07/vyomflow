# Security Policy

## Supported Versions

Only the `main` branch is supported. There are no maintained release branches.

## Reporting a Vulnerability

If you believe you've found a security vulnerability in VyomFlow, please report it privately
rather than opening a public issue.

- Preferred: use [GitHub Private Vulnerability Reporting](../../security/advisories/new) on this
  repository.
- Alternative: email **myselfpranjal2005@gmail.com** with a description of the issue and steps to
  reproduce.

Please do not disclose the issue publicly until it has been addressed. You can expect an initial
response within **48 hours**.

## Scope

In scope:

- Authentication and authorization boundaries (session, API key, and MCP access)
- Data ownership and cross-user access control
- Billing/credit integrity
- Webhook delivery and signature verification

Out of scope:

- Vulnerabilities in third-party services VyomFlow depends on (report those to the provider
  directly)
- Rate limits or quota behavior of third-party free-tier providers
