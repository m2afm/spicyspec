// backend-pack.ts
// Checklist pack for backend/API production-readiness review.
// Every item's evidence is a concrete, executable proof (command, probe, file/line,
// or test) -- never "review the code". An item that can be ticked without proof is
// intentionally absent by design.

import { parsePack, type GatePack } from './pack.js';

export const backendPack: GatePack = parsePack({
  id: 'backend-checklist',
  name: 'Backend checklist',
  stages: ['execute', 'converge'],
  seat: 'backend-reviewer',
  execute: true,
  items: [
    {
      id: 'BE-001',
      requirement: 'Validate every request payload against a schema at the API boundary before it reaches business logic.',
      severity: 'critical',
      evidence: 'Open each changed controller/handler and confirm a schema guard (zod/joi/class-validator DTO) runs first; then POST a payload with a wrong-typed and a missing required field and confirm a 400 with field errors, not a 500.',
    },
    {
      id: 'BE-002',
      requirement: 'Handle errors explicitly and never swallow a caught exception silently.',
      severity: 'high',
      evidence: 'grep the changed files for catch blocks with an empty body or a lone comment (rg -n "catch\\s*\\([^)]*\\)\\s*\\{\\s*\\}") returns nothing; every remaining catch either rethrows, maps to a typed error response, or logs with context.',
    },
    {
      id: 'BE-003',
      requirement: 'Keep all secrets out of source and load them from the environment or a secret manager.',
      severity: 'critical',
      evidence: 'rg -nI "(api[_-]?key|secret|password|token|private[_-]?key)\\s*[:=]\\s*[\\x27\\x22][A-Za-z0-9/+_-]{12,}" over the changed range returns nothing; each hit that remains resolves to process.env or a vault client, not a literal.',
    },
    {
      id: 'BE-004',
      requirement: 'Build every database query with parameter binding and never concatenate user input into SQL.',
      severity: 'critical',
      evidence: 'grep for string-concatenated SQL in the changed files (rg -n "(SELECT|INSERT|UPDATE|DELETE).*(\\+|\\$\\{|`)" -i) returns nothing; all queries use the ORM/query-builder or driver placeholders ($1, ?, :name).',
    },
    {
      id: 'BE-005',
      requirement: 'Enforce authorization server-side on every mutating endpoint before the write executes.',
      severity: 'critical',
      evidence: 'Every POST/PUT/PATCH/DELETE handler calls the authorization guard before the mutation -- open each and confirm; then call one mutating route without a token and once with a token lacking the role, both return 401/403 (proven by an executed request).',
    },
    {
      id: 'BE-006',
      requirement: 'Make money and webhook write paths idempotent so a retried request cannot double-apply.',
      severity: 'critical',
      evidence: 'Confirm each payment/webhook handler reads an idempotency key (or provider event id) and short-circuits on replay; then POST the same webhook body twice and assert exactly one row/side effect via a DB count query.',
    },
    {
      id: 'BE-007',
      requirement: 'Apply rate limiting to every publicly reachable endpoint.',
      severity: 'high',
      evidence: 'Confirm the rate-limit middleware is registered on the public router (open the module wiring); then fire N+1 requests past the configured limit with a loop (for i in $(seq 1 <limit+5>); do curl -s -o /dev/null -w "%{http_code}\\n" <url>; done) and observe 429 responses.',
    },
    {
      id: 'BE-008',
      requirement: 'Ship migrations that comply with the reversibility/forward-only policy in force for this service.',
      severity: 'medium',
      evidence: 'Run the migration up then down on a scratch DB (or apply then the documented rollback command) and confirm both complete with no error; if policy is forward-only, confirm no destructive DROP/rename lands in the same release as its reads.',
    },
    {
      id: 'BE-009',
      requirement: 'Eliminate N+1 query patterns on list endpoints.',
      severity: 'high',
      evidence: 'Hit each changed list endpoint with the SQL/ORM query logger on (e.g. Prisma DEBUG or a query count assertion in a test) and confirm the emitted query count stays constant as the row count grows, rather than one query per item.',
    },
    {
      id: 'BE-010',
      requirement: 'Bound every collection query with a pagination limit and never issue an unbounded SELECT.',
      severity: 'high',
      evidence: 'rg -n "findMany|SELECT" over the changed data layer shows each list read carries a take/LIMIT with a hard maximum; call a list endpoint with limit=100000 and confirm the server clamps to the max rather than returning the whole table.',
    },
    {
      id: 'BE-011',
      requirement: 'Wrap every multi-write operation in a single transaction so partial failures roll back.',
      severity: 'high',
      evidence: 'Open each handler that performs two or more writes and confirm they run inside one transaction ($transaction / BEGIN..COMMIT); then force the second write to fail in a test and assert the first write is absent via a DB count.',
    },
    {
      id: 'BE-012',
      requirement: 'Emit structured logs that never contain PII, credentials, or raw secrets.',
      severity: 'medium',
      evidence: 'Trigger the changed code paths and grep the captured log output (rg -ni "password|token|ssn|card|authorization: bearer") for zero matches; confirm logs are JSON with level/requestId fields, not free-text console.log.',
    },
    {
      id: 'BE-013',
      requirement: 'Expose a health/readiness endpoint that reflects real dependency status.',
      severity: 'medium',
      evidence: 'curl the readiness route and confirm HTTP 200 with a JSON body reporting DB/cache reachability; stop the database and confirm the same route flips to 503 rather than staying 200.',
    },
    {
      id: 'BE-014',
      requirement: 'Cover new backend logic with tests reaching at least 80 percent.',
      severity: 'high',
      evidence: 'nx test <api> --coverage reports >= 80% branch coverage on the changed module in the coverage summary; the changed files appear in the report and are not excluded by config.',
    },
    {
      id: 'BE-015',
      requirement: 'Pass the build and type-check gate with zero errors.',
      severity: 'critical',
      evidence: 'nx run <api>:build and nx run <api>:typecheck (or tsc --noEmit) both exit 0 with no reported errors on the current tree.',
    },
    {
      id: 'BE-016',
      requirement: 'Run the integration test tier green end to end.',
      severity: 'high',
      evidence: 'nx run <api>:test-integration (or the documented integration target) exits 0 with all suites passing against a real DB/container, not skipped or marked pending.',
    },
  ],
});
