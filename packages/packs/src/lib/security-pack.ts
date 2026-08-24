// security-pack.ts
// Checklist pack for the OWASP Top 10 essentials plus secret hygiene.
// Every item's evidence is a concrete, executable proof (attack probe, audit
// command, git query, or test) -- never "review the code". Items that cannot be
// proven are intentionally absent by design.

import { parsePack, type GatePack } from './pack.js';

export const securityPack: GatePack = parsePack({
  id: 'security-checklist',
  name: 'Security checklist',
  stages: ['plan', 'converge'],
  seat: 'security-reviewer',
  execute: false,
  items: [
    {
      id: 'SEC-001',
      requirement: 'Check object ownership on every access so a user cannot reach another user\x27s record (IDOR).',
      severity: 'critical',
      evidence: 'Attempt to fetch and to mutate another user\x27s object by id while authenticated as a different user; both return 403/404 (never 200 with the object), proven by an executed test that asserts the status and empty body.',
    },
    {
      id: 'SEC-002',
      requirement: 'Prevent SQL/NoSQL injection by using parameterized queries for all data access.',
      severity: 'critical',
      evidence: 'Send a classic injection payload (id=1 OR 1=1, or a Mongo {"$gt":""} operator) to each data-reading route and confirm it is treated as a literal (no extra rows, no error); grep the changed data layer for concatenated queries returns nothing.',
    },
    {
      id: 'SEC-003',
      requirement: 'Block command injection by never passing user input to a shell.',
      severity: 'critical',
      evidence: 'rg -n "exec\\(|execSync|spawn\\(.*shell:\\s*true|child_process" over the changed files; each hit either takes no user input or uses an argument array with shell:false -- confirm by opening, then send a "; id" style payload and assert no shell metacharacter executes.',
    },
    {
      id: 'SEC-004',
      requirement: 'Encode or sanitize all user-controlled output rendered into HTML to stop XSS.',
      severity: 'high',
      evidence: 'Submit a <script>alert(1)</script> payload through each input that is later rendered and confirm it appears escaped in the response body (rg the response for the literal &lt;script&gt;), not as an active tag; confirm no dangerouslySetInnerHTML/innerHTML sink consumes it unsanitized.',
    },
    {
      id: 'SEC-005',
      requirement: 'Encrypt secrets and sensitive data at rest rather than storing them in plaintext.',
      severity: 'critical',
      evidence: 'Query the stored column/secret store directly (SELECT on the sensitive column, or read the secret backend) and confirm the value is ciphertext/managed-reference, not a readable plaintext credential.',
    },
    {
      id: 'SEC-006',
      requirement: 'Enforce TLS on all transport and redirect or reject plaintext HTTP.',
      severity: 'high',
      evidence: 'curl -I the plaintext http:// origin and confirm a 301/308 to https:// or a connection refusal; confirm HSTS is present (curl -sI https://... | rg -i strict-transport-security).',
    },
    {
      id: 'SEC-007',
      requirement: 'Hash passwords with a strong adaptive algorithm and never a weak/fast hash.',
      severity: 'critical',
      evidence: 'rg -ni "md5|sha1|createHash" over the auth/password code returns nothing for password handling; confirm bcrypt/scrypt/argon2 is the hasher and inspect a stored hash to confirm its algorithm prefix ($2b$ / $argon2).',
    },
    {
      id: 'SEC-008',
      requirement: 'Guard every URL-fetching path against SSRF by validating the destination.',
      severity: 'critical',
      evidence: 'Point each server-side fetch/webhook/import feature at http://169.254.169.254/ and at http://127.0.0.1/ and confirm the request is rejected by an allowlist/private-IP block, proven by an executed test asserting the block, not a metadata response.',
    },
    {
      id: 'SEC-009',
      requirement: 'Avoid insecure deserialization of untrusted input into executable objects.',
      severity: 'high',
      evidence: 'rg -n "eval\\(|Function\\(|node-serialize|yaml.load\\(|pickle" over the changed files returns nothing that consumes request data; parsers are JSON.parse or yaml.safeLoad with schema validation on the result -- confirm by opening each hit.',
    },
    {
      id: 'SEC-010',
      requirement: 'Remove insecure defaults: disable debug/verbose errors in production and delete default credentials.',
      severity: 'high',
      evidence: 'Confirm NODE_ENV=production disables stack traces (trigger an error against a prod-config instance and confirm the body has no stack); grep config/seed for default users like admin/admin or a seeded password returns nothing shipped to prod.',
    },
    {
      id: 'SEC-011',
      requirement: 'Ship with no known-vulnerable dependencies.',
      severity: 'high',
      evidence: 'pnpm audit --prod reports zero high/critical advisories (exit 0); any remaining advisory has a recorded, dated waiver.',
    },
    {
      id: 'SEC-012',
      requirement: 'Enforce session/token expiry and brute-force protection on authentication.',
      severity: 'high',
      evidence: 'Decode an issued JWT/session and confirm a short exp claim (probe a route with an expired token and get 401); attempt N failed logins in a loop and confirm lockout/throttling returns 429 after the threshold.',
    },
    {
      id: 'SEC-013',
      requirement: 'Keep sensitive data out of logs, error responses, and URLs.',
      severity: 'high',
      evidence: 'rg -ni "password|token|ssn|card|secret" over captured logs and error bodies returns nothing; grep the route table and access logs for sensitive values in query strings (rg "\\?.*(token|password|ssn)=") returns nothing.',
    },
    {
      id: 'SEC-014',
      requirement: 'Protect state-changing browser routes against CSRF.',
      severity: 'high',
      evidence: 'Replay a cookie-authenticated POST from a foreign origin without the CSRF token / with a mismatched SameSite cookie and confirm it is rejected (403), proven by an executed cross-origin request; confirm the token/ SameSite=strict setting in the session config.',
    },
    {
      id: 'SEC-015',
      requirement: 'Serve the baseline security response headers on every route.',
      severity: 'medium',
      evidence: 'curl -sI a representative route and confirm Content-Security-Policy, X-Content-Type-Options: nosniff, X-Frame-Options/frame-ancestors, and Referrer-Policy are all present (rg them out of the header dump).',
    },
    {
      id: 'SEC-016',
      requirement: 'Keep secrets out of git history across the entire changed range.',
      severity: 'critical',
      evidence: 'git log -p over the changed range shows no added token/key/password literal; a secret scanner over the diff (gitleaks detect --no-git on the range, or trufflehog) reports zero findings.',
    },
  ],
});
