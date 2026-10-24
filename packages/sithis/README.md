# Sithis Pi pentest package

Version 0.1.0 provides a resumable web/API assessment workflow. It uses Node
builtins, requires no database service or model API for its tools, and stores
engagements independently of Pi conversations. The Pi package exposes six
specialists and `/engagement` operator commands.

## Start

Install/restart Sithis after pulling these changes; the checkout's settings already include
`../packages/sithis`. No installation of ptai is required. Build the SDK host and local TUI with
`npm run setup` before running the host integration tests. From the repository root:

```sh
npm test --prefix packages/sithis
npm run demo --prefix packages/sithis
```

The demo starts its own loopback fixture, proves a synthetic disclosure, applies
a fixture patch, retests, and prints the report location. It makes no external
requests and needs no model. Tests cover vulnerable and clean controls, scope,
budgets, artifacts, replay, cancellation, response limits and Pi integration.
The Pi host integration test runs when the pinned host is installed; otherwise
it is explicitly skipped. The core tests and demo still run in CI.

## Engagements

Data defaults to `~/.local/share/sithis`; set `SITHIS_DATA_DIR` before starting Pi
or the CLI to choose another location. Each engagement has a private directory,
`state.json`, immutable evidence files, and a generated `report.md`. Do not put
this directory in source control. Raw evidence may contain cookies, personal
data, or credentials. Capture credentials by external secret reference, not in
scope or finding descriptions. There is no credential database.

Edit `examples/scope.json` with your authorized hosts, ports, end time, and rules
reference. Entries are lowercase exact hosts, `*.domain` subdomains (excluding
the apex), IPv4/IPv6 addresses, or CIDRs. Exclusions win. A hostname allowlist
allows its resolved addresses except explicit exclusions; use exclusions for
internal ranges when appropriate to your engagement. URL path restrictions are
not supported: use host-level scope only in this version. IPv4-mapped IPv6 is
rejected. Empty or expired scopes cannot make requests.

```sh
node packages/sithis/src/cli.mjs new customer-demo @my-scope.json
node packages/sithis/src/cli.mjs resume customer-demo
```

In Sithis, enter `/engagement` for the menu or `/engagement new` for guided setup.
Invalid fields can be retried without re-entering previous answers. Review the
completed scope before saving; Escape cancels without creating an engagement. You can also load a scope
file directly: `/engagement new customer-demo @my-scope.json` (plain file paths
work too). Relative paths resolve from Pi's working directory; quote paths with
spaces. `/engagement help` shows examples and `/engagement list` shows saved work.

```text
/engagement resume customer-demo
/engagement status
/engagement report
/engagement leave
```

Alternatively `/engagement new customer-demo {scope JSON}` creates and selects
an engagement. Selecting one blocks other model tools, including shell, web
fetch, MCP and delegation, until `/engagement leave`. The selection survives
session resume and branch reconstruction. Operator slash commands still work.
This gate is local to that Pi session, not an operating-system sandbox or a
policy for other processes. Run only trusted extensions. An external execution
backend needs its own scope checks and network restrictions.

There is deliberately no global active-engagement file: every tool and agent
request names its engagement so concurrent sessions cannot silently switch one
another's targets.

## Tool payloads

`sithis_assess` accepts `{engagement, operation, data}`. Scope creation, evidence
capture from outside the runner, and manual approvals are operator commands,
not model operations.

| Operation | `data` |
| --- | --- |
| `status`, `resume`, `report` | `{}` |
| `probe` | `{ "url": "https://app.example.test/path" }` |
| `evidence` | `{ "evidence": "artifact ID" }` |
| `finding` | `{ "title": "...", "url": "...", "severity": "low", "description": "...", "remediation": "...", "evidence": ["artifact ID"], "recipe": { ... } }` |
| `verify`, `retest`, `capsule` | `{ "finding": "finding ID" }` |
| `coverage` | `{ "url": "...", "role": "anonymous", "parameter": "q", "check": "reflection", "status": "tested", "reason": "...", "evidence": ["artifact ID"] }` |
| `import` | A complete exported capsule JSON object |

Coverage statuses: `tested`, `skipped`, `blocked`, `unknown`. Tested entries need
evidence. Candidate findings are deduplicated by exact URL and title; severity
is one of `info`, `low`, `medium`, `high`, `critical`. This is not semantic
vulnerability deduplication. Resume returns coverage, assets, pending work,
recent actions and the remaining request budget.

`sithis_inspect` supports only status, resume, evidence, report and capsule.
Planning and reporting agents use this tool and cannot send target requests.

The CLI accepts all operations with the same payload:

```sh
node packages/sithis/src/cli.mjs probe customer-demo '{"url":"https://app.example.test/"}'
node packages/sithis/src/cli.mjs finding customer-demo @candidate.json
node packages/sithis/src/cli.mjs report customer-demo
```

## Evidence and verification

The runner sends GET requests only, verifies TLS, pins the checked DNS address,
disables connection reuse and automatic redirects, bounds DNS lookup and total
request duration, and limits responses to 1 MiB. Original body bytes are retained
in base64 alongside decoded text, response headers, resolved address, timestamps
and Node version. The model receives a summary and evidence ID; raw evidence is
retrieved explicitly and must be treated as untrusted data.

Budgets are shared on disk across agents and processes. Requests reserve their
budget before execution; failed and cancelled requests still consume it.
Per-host rate limits reject immediately rather than silently queue. Verification
waits between its own requests. Retrying after a recent separate probe may be
necessary. Redirect destinations must be probed explicitly and pass fresh scope
checks. A GET can still have side effects: choose endpoints according to the
rules of engagement.

The first automatic recipe is deliberately narrow:

```json
{
  "kind": "http-marker",
  "url": "https://app.example.test/probe",
  "controlUrl": "https://app.example.test/control",
  "marker": "SITHIS_CONTROLLED_CANARY_9173",
  "status": 200,
  "claim": "Describe the hypothesis being checked"
}
```

Verification requests the probe and negative control twice. Both probe responses
must have the expected status and contain the marker; both controls must have
the same expected status and lack it. The receipt states the exact observation,
independently of the submitted claim. Reflection alone never establishes XSS
execution. The finding title is operator/agent-supplied, so reviewers must still
check that the title and business impact match the demonstrated observation.

Unsupported classes stay candidates until explicit manual review. Import browser
or other external evidence through the CLI or operator command:

```text
/engagement capture {"kind":"manual-browser-observation","content":{"description":"...","externalArtifact":"secure reference","sha256":"..."}}
/engagement review {"finding":"ID","status":"verified","reviewer":"operator name","reason":"What was reproduced and why it proves the claim","evidence":["CAPTURED_ARTIFACT_ID"]}
/engagement review {"finding":"ID","status":"fixed","reviewer":"operator name","reason":"Patch deployed"}
```

Use `retest` to rerun the original recipe after marking a finding fixed. Two
successful controls with no marker in either probe produce `retested`; a still
present marker reopens it as verified; errors or inconsistent results are
inconclusive. Manual browser/authentication findings require manual retesting
in this version: use operator review with status `retested`, new evidence IDs,
and a description of the repeated procedure after marking the finding fixed. Manual reviews are attestations, distinguished from machine
receipts, and the CLI does not independently authenticate the reviewer string.

Reports include verified/fixed/retested records, remediation, evidence IDs and
coverage limitations. They omit unconfirmed finding details while counting
them. A capsule exports a verified finding, recipe, receipts and evidence.
Importing it creates a fresh candidate; verify it inside an independently
created scope. Its checksum detects drift, not authorship or authenticity.
Capsules are private artifacts and need review/redaction before sharing.

State updates use atomic replacement under an exclusive per-engagement lock.
Contending writers fail closed and can retry. After a crash, inspect running
processes before manually removing a stale `.lock` directory. No automatic lock
stealing is performed. Back up the entire engagement directory for continuity.

## Specialists and handoffs

The package exposes `sithis-engagement-planner`, `sithis-recon-analyst`,
`sithis-web-api-tester`, `sithis-poc-validator`, `sithis-report-writer`, and
`sithis-fix-verifier`. They load the Sithis extension explicitly and have no
shell, general file, web, or MCP tools. They inherit your configured model.
Each task must include the engagement ID and bounded objective. Each specialist
resumes state first and returns evidence IDs and pending checks.

For delegation with the installed pi-subagents package, first leave the main
session's restricted engagement mode, then explicitly delegate to the desired
Sithis specialist with the engagement ID. Example request:

```text
Use sithis-recon-analyst for engagement customer-demo to inspect the recorded
assets and probe only https://app.example.test/. Return evidence IDs and gaps.
```

Delegate one phase at a time initially: planner → recon → web/API tester →
validator → report writer → fix verifier after patching. Request budgets remain
shared. There is no automatic swarm fanout, model cost accounting, or token
budget scheduler in 0.1.0.

## Optional ptai experiment

`examples/ptai-mcp.json` is an uninstalled example using the reviewed `ptai mcp`
entry point. It is intentionally not merged into your live Pi MCP configuration:
ptai has a separate execution and state boundary and must be evaluated on local
fixtures before enabling live target access. Do not assume Sithis scope covers
an MCP server. Import any resulting evidence through operator capture and keep
Sithis's engagement store authoritative. Reviewed upstream snapshots:

- pentest-ai: `85b5509907724ffe2cc1879e81398c6ba228adad`
- pentest-ai-agents: `e5d7aa02c4c0c29a90e4789034b45e0cb7488e89`

No upstream executable code or specialist prompts have been vendored.

## Current boundary

This milestone implements the storage, scoped HTTP workflow, evidence,
specialists, manual and machine verdicts, reporting, replay, retesting and local
regression fixtures. Port-scanner adapters, automated browser capture,
authenticated two-role oracles, OS/network sandbox deployment, automatic
orchestration, model benchmarking/cost metrics, and AD/cloud workflows remain
future additions. The Pi host and its trusted extensions retain host privileges;
Sithis does not claim to sandbox arbitrary Pi code.
