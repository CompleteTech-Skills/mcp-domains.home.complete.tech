# Domain Suite MCP

TypeScript Model Context Protocol (MCP) server for domain discovery, registrar
comparison, heuristic scoring, and guarded domain registration.

## Setup

Use Node.js 22 or newer for the commands below.

```sh
npm ci
cp .env.example .env
npm run build
node --env-file=.env build/index.js
```

On PowerShell, use `Copy-Item .env.example .env`. Fill in credentials locally only
when a provider needs them. The server reads process environment variables;
`npm start` does not automatically load `.env`. For an MCP client, launch
`node` with arguments `--env-file=/absolute/path/to/.env` and
`/absolute/path/to/build/index.js`, or supply variables through the client's
environment configuration. Keep that client configuration private.

Public RDAP lookups and Porkbun TLD pricing work without registrar credentials.
Namecheap needs API access and an allowlisted client IP. Exact quotes and live
registration depend on provider permissions and API support. RDAP signals and
estimated prices are not guarantees of availability or checkout cost.

## Tools

- `discover_domain_options`: generate and rank candidates for a naming brief.
- `compare_domain_prices`: compare registrar quotes for one domain.
- `assess_domain_candidates`: rank an existing shortlist.
- `plan_domain_purchase`: prepare a purchase plan and confirmation phrase.
- `register_domain`: request guarded registration through Porkbun or Cloudflare.

`DOMAIN_PURCHASE_MODE` defaults to `disabled`. `manual` sends no registration
order; `live` enables billable registration attempts. Obtain explicit approval
for the exact domain, registrar, and price before registering. A confirmation
phrase is not authentication or a substitute for user consent.

Purchase guards use the selected registrar's available, exact USD quote. A
registration request must name that same registrar and match the freshly
compared domain and price. Missing, estimated, unavailable, or invalid quotes
do not produce a guard. This comparison check does not guarantee provider-side
price enforcement if a price changes during registration.

## HTTP transport

```sh
node --env-file=.env build/server-http.js
```

The default endpoint is `http://127.0.0.1:3015/mcp`, with `/health` for status.
This transport has no built-in authentication and permits cross-origin requests.
Use it only in a trusted local environment. Any network deployment needs an
authenticated access layer and appropriate network controls, especially when
registrar credentials or live purchasing are enabled.

## Development and publication

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

`npm run dev` and `npm run dev:http` run source with `tsx`; supply environment
variables explicitly. Source lives in `src/`, provider adapters in
`src/providers/`, and the optional agent workflow in `skills/domain-buyer/`.

Git excludes credentials, local MCP configuration, private `research/` output,
builds, and dependency directories. The npm package uses an explicit file
allowlist. These controls do not remove files already tracked in Git: review
`git ls-files`, package contents, and all publishable history before release.
Keep private backups and research outside any source archive intended to share.
Run a secret scanner over both the current files and the complete Git history.
