# Sithis improvement recommendations

Date: 2026-10-24

These recommendations compare Sithis's current implementation with documentation
and selected agent prompts from
[pentest-ai](https://github.com/0xSteph/pentest-ai) and
[pentest-ai-agents](https://github.com/0xSteph/pentest-ai-agents).
They are proposals, not implemented features. Command examples describe possible
interfaces. Upstream links point to mutable branches; documented capabilities
may differ from released versions. This review is not a full upstream code audit.

## Assessment

The biggest opportunity is to make Sithis guide a complete assessment more
easily, then expand what it can independently verify.

`pentest-ai-agents` supplies specialist instructions and workflow patterns.
`pentest-ai` supplies an execution, verification, and reporting system. A prompt
describing orchestration does not itself implement a scheduler.

Sithis already provides engagement storage, scoped HTTP requests, shared request
budgets, immutable evidence files with integrity checks, verification receipts,
replay capsules, coverage records, fix retesting, and six specialist definitions.
The recommendations below build on those capabilities.

## Priorities

| Priority | Improvement | Outcome | Estimated effort |
| --- | --- | --- | --- |
| 1 | Guided assessment playbooks | Save and resume a workflow from discovery through reporting | Medium |
| 2 | Authenticated testing | Compare access across anonymous users, separate accounts, and roles | Large |
| 3 | More verification recipes | Prove specific security failures beyond HTTP marker observations | Large |
| 4 | Endpoint discovery and import | Build an inventory from API definitions and recorded requests | Medium |
| 5 | Engagement dashboard | Expose pending work, coverage gaps, deadlines, and budgets | Small–medium |
| 6 | Better reports and exports | Produce developer reports, bounty submissions, JSON, and SARIF | Medium |
| 7 | Structured scanner imports | Convert external results into traceable candidates | Medium |
| 8 | Capability diagnostics | Explain available workflows and missing dependencies | Small–medium |

Effort estimates are relative and require implementation planning. Priority
reflects product value; the delivery sequence below accounts for dependencies
and opportunities to improve existing functionality quickly.

## 1. Guided assessment playbooks

Add a proposed `/engagement run` menu:

```text
Web application assessment
API assessment
Verify pending findings
Retest fixes
Generate report
```

Each workflow should:

- Present its planned checks and estimated request usage.
- Persist step state, results, evidence references, and reasons for blocked work.
- Resume after interruption without repeating completed requests unnecessarily.
- Respect the existing scope, expiration, and shared request budgets.
- Pass bounded tasks and structured results between specialists.

Start with sequential execution. Sithis currently requires leaving engagement
mode to delegate to specialists. A scoped workflow runner should make specialist
handoffs possible while retaining engagement restrictions and explicit
engagement IDs.

The first useful playbook is **Verify pending findings**: collect candidates
with supported recipes, show the planned checks and budget estimate, run them,
and summarize verified, inconclusive, and blocked outcomes. Unsupported recipes
should remain pending for manual review.

Sources:

- [Pentest-AI playbook example](https://github.com/0xSteph/pentest-ai#bug-bounty-automation)
- [Agent orchestration and lifecycle prompt](https://github.com/0xSteph/pentest-ai-agents/blob/main/agents/swarm-orchestrator.md)

## 2. Authenticated testing with separate identities

Sithis currently sends GET requests without configurable authentication. Add
named authentication profiles backed by external secret references.

Support separate sessions for anonymous access, user A, user B, and an
administrative role. Keep credentials out of prompts, finding descriptions, and
shared exports. Detect expired sessions and login redirects so authentication
failure cannot masquerade as a meaningful test result.

A first workflow should compare:

1. User A successfully accessing a resource owned by user A.
2. User B attempting to access that same resource.
3. Anonymous access as an additional control.

Use operator-supplied test accounts and ownership expectations. Record the
tested identities by profile reference and retain evidence for each comparison.
Expand into role and tenant isolation checks once session handling is reliable.

Source:
[API specialist: authorization and authentication methodology](https://github.com/0xSteph/pentest-ai-agents/blob/main/agents/api-security.md).

## 3. Expand independent verification

Sithis currently has one automatic `http-marker` recipe. Its receipt correctly
describes a marker observation rather than claiming script execution or general
exploitability. Preserve that precision as additional recipes are introduced.

Recommended additions:

- Cross-user and cross-role access checks, using authenticated profiles.
- Structured JSON assertions for unintended data exposure, with controlled
  resources and expected ownership.
- Controlled redirect verification.
- Browser execution checks for XSS, distinguishing execution from reflection.

Every recipe should define the exact observation it proves, required controls,
repeatability criteria, evidence artifacts, and inconclusive conditions.
Unsupported claims should remain candidates until explicit manual review.

Upstream's capability inventory distinguishes registered probes, verification
recipes, and wrappers that actually parse output into findings. Adopt that
distinction in Sithis documentation rather than treating tool counts as proof of
assessment quality.

Sources:

- [Verification design](https://github.com/0xSteph/pentest-ai/blob/main/docs/why-verification.md)
- [Capability inventory and limitations](https://github.com/0xSteph/pentest-ai/blob/main/docs/capability-inventory.md)

## 4. Endpoint discovery and import

Import OpenAPI definitions, request collections, and recorded traffic into a
structured endpoint inventory.

Track method, path, parameters, authentication role, source, and test status.
Connect inventory entries to Sithis's existing coverage records so users can
see which known endpoints have untested parameters or role combinations.

Imported endpoints should remain inactive until they pass scope validation.
Introduce URL-path and HTTP-method restrictions alongside this work; Sithis's
current scope is host- and port-based. Preserve restrictions when importing API
definitions or external program scope.

API definitions may describe state-changing operations that the current GET-only
runner cannot execute. Record those as unsupported or blocked until an
appropriate runner and explicit execution policy exist.

Source:
[API discovery and inventory methodology](https://github.com/0xSteph/pentest-ai-agents/blob/main/agents/api-security.md).

## 5. Engagement dashboard

Build on the expiration preset menu with an engagement overview:

```text
Expires in: 3h 42m
Requests: 24 / 100
Endpoints: 18 discovered · 7 tested · 3 blocked
Findings: 2 verified · 4 awaiting validation

Continue assessment
Review pending findings
View coverage gaps
Retest fixes
Export report
```

The values above are illustrative. Derive displayed counts and progress from
saved state, task outcomes, and evidence. Until an endpoint inventory exists,
show recorded coverage counts without implying a known total application
surface.

Include readable deadlines, remaining time, budget usage, pending findings,
blocked work with reasons, and the next available action. Keep candidate,
machine-verified, and manually reviewed outcomes distinguishable.

Source:
[Orchestration dashboard concept](https://github.com/0xSteph/pentest-ai-agents/blob/main/agents/swarm-orchestrator.md).

## 6. Better reports and exports

Extend the existing Markdown report with:

- Reproducible requests or procedures, with secrets represented by references.
- Precise demonstrated impact and remediation guidance.
- CWE mappings and optional CVSS scores with their rationale.
- A clear distinction between machine receipts and manual attestations.
- Coverage limitations and unresolved checks.
- Developer, bug-bounty, JSON, and SARIF export formats.
- Redacted evidence exports that retain references to the original artifacts.

Generate exports from saved evidence and reviewed findings. A report generator
should not invent reproduction steps, impact, or verification results. Keep raw
private artifacts intact when producing redacted copies.

Source:
[Pentest-AI reporting and export workflows](https://github.com/0xSteph/pentest-ai#what-you-can-do).

## 7. Structured scanner imports

Start with structured output ingestion before adding direct scanner execution.
Parse supported external results into candidate findings, retaining:

- Tool name and version, when supplied.
- Import time and original artifact reference.
- Target and relevant request details.
- Parser version and links to the resulting candidates.

Preserve raw results as evidence. Imported scanner claims must not become
verified findings automatically; route them through supported verification
recipes or manual review. Deduplicate candidates while retaining separate
source evidence.

Any later scanner execution adapter must enforce scope and request policy at
its own execution boundary. Installing a wrapper does not establish that its
underlying tool respects Sithis's controls.

Sources:

- [Scanner verification policy](https://github.com/0xSteph/pentest-ai/blob/main/docs/why-verification.md)
- [Structured parser coverage versus wrapper counts](https://github.com/0xSteph/pentest-ai/blob/main/docs/capability-inventory.md)

## 8. Capability diagnostics

Extend Sithis's existing startup doctor beyond SDK and TUI resolution to check:

- Discovery of the six Sithis specialists.
- Availability of registered verification recipes.
- Readiness of authentication profiles without exposing secrets.
- Optional browser and scanner dependencies as those features are introduced.
- Whether a selected workflow is runnable and what blocks it.

Present actionable results grouped by workflow or specialist. Distinguish
installed tools from capabilities integrated into Sithis. Offer a structured
JSON result for diagnostics and CI.

Source:
[Agent tool audit implementation](https://github.com/0xSteph/pentest-ai-agents/blob/main/db/doctor.sh).

## Recommended delivery sequence

1. Add the engagement dashboard and a guided **Verify pending findings** workflow.
   These make existing capabilities easier to use immediately.
2. Implement authenticated profiles and controlled cross-user access verification.
   These provide the largest practical increase in web/API assessment capability.
3. Add endpoint inventory, import, and method/path restrictions, then expand
   playbooks around measurable coverage.
4. Add further verification recipes, richer exports, and structured scanner
   imports. Extend diagnostics as each capability lands.

Validate new execution and verification capabilities with vulnerable and hardened
fixtures, negative controls, scope rejection cases, and interrupted/resumed
workflows. Preserve Sithis's existing separation between candidate claims,
machine observations, and operator attestations throughout these changes.
