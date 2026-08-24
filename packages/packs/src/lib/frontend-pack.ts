// frontend-pack.ts
// -----------------------------------------------------------------------------
// The "frontend-checklist" gate pack. It joins the gate for the `execute` and
// `converge` pipeline stages under the `frontend-reviewer` seat. Every item is
// a production-frontend concern (rendered semantics, reachable UI states, clean
// console/network on the happy path, responsive layout, form validation, no
// leaked secrets, image hygiene, theming, and a clickable primary action) and
// carries CONCRETE evidence: a command to run, an artifact to open, or a value
// to compute. Nothing here can be ticked by "eyeballing the code" -- each item
// names the exact thing that must be executed or read to prove it true.
// -----------------------------------------------------------------------------

import { parsePack, type GatePack } from './pack.js';

export const frontendPack: GatePack = parsePack({
  id: 'frontend-checklist',
  name: 'Frontend checklist',
  stages: ['execute', 'converge'],
  seat: 'frontend-reviewer',
  execute: true,
  items: [
    {
      id: 'FE-001',
      requirement:
        'The primary route renders with zero error-level console messages.',
      severity: 'critical',
      evidence:
        "read_console_messages({ onlyErrors: true }) on the primary route returns an empty array (zero error-level entries) after full load.",
    },
    {
      id: 'FE-002',
      requirement:
        'Every network call on the happy path returns a 2xx status (no 4xx/5xx).',
      severity: 'critical',
      evidence:
        "read_network_requests on the primary route: every entry's response status is in [200,399]; assert none match /^[45]\\d\\d$/.",
    },
    {
      id: 'FE-003',
      requirement:
        'The rendered output is semantically correct HTML with a single top-level h1 and a <main> landmark.',
      severity: 'high',
      evidence:
        "read_page (accessibility tree) shows exactly one heading level 1 and one main landmark; document.querySelectorAll('h1').length === 1.",
    },
    {
      id: 'FE-004',
      requirement:
        'The loading state exists and is reachable before data resolves on the primary data view.',
      severity: 'high',
      evidence:
        "Throttle the network in devtools, reload, and confirm a [data-state=\"loading\"] or role=\"status\" element is present in read_page before the fetch settles.",
    },
    {
      id: 'FE-005',
      requirement:
        'The empty state renders reachable UI when the data source returns zero items.',
      severity: 'high',
      evidence:
        "Point the view at a fixture/endpoint returning [] and confirm the empty-state node (e.g. [data-state=\"empty\"]) appears in get_page_text with its guidance copy.",
    },
    {
      id: 'FE-006',
      requirement:
        'The error state renders reachable UI when the data request fails.',
      severity: 'high',
      evidence:
        "Force the data endpoint to 500 (devtools request-block or a failing fixture), reload, and confirm an [role=\"alert\"] / [data-state=\"error\"] node appears in read_page.",
    },
    {
      id: 'FE-007',
      requirement:
        'The body never scrolls horizontally at 375px mobile width.',
      severity: 'high',
      evidence:
        "resize_window to 375px, then javascript_tool: document.body.scrollWidth <= window.innerWidth evaluates to true.",
    },
    {
      id: 'FE-008',
      requirement:
        'No individual element overflows the viewport horizontally at mobile width.',
      severity: 'medium',
      evidence:
        "At 375px, javascript_tool: [...document.querySelectorAll('*')].every(el => el.getBoundingClientRect().right <= window.innerWidth + 1) is true.",
    },
    {
      id: 'FE-009',
      requirement:
        'Forms reject invalid input and display a visible, associated error message.',
      severity: 'high',
      evidence:
        "Submit the form with an invalid required field; confirm submission is blocked and an error node referenced by aria-describedby is visible in read_page.",
    },
    {
      id: 'FE-010',
      requirement:
        'The client bundle contains no hardcoded secrets, private keys, or bearer tokens.',
      severity: 'critical',
      evidence:
        "grep -rEn '(sk_live_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer [A-Za-z0-9._-]{20,})' dist/ returns no matches.",
    },
    {
      id: 'FE-011',
      requirement:
        'All content images declare width and height and a non-empty alt attribute.',
      severity: 'medium',
      evidence:
        "javascript_tool: [...document.images].every(i => i.hasAttribute('width') && i.hasAttribute('height') && i.alt.trim() !== '') is true.",
    },
    {
      id: 'FE-012',
      requirement:
        'The production bundle carries no obvious dead weight (no sourcemaps shipped, no duplicated major deps).',
      severity: 'medium',
      evidence:
        "Run the bundler analyzer (e.g. `npx vite-bundle-visualizer` or `source-map-explorer dist/**/*.js`) and confirm no *.map files in dist/ and no duplicate copies of the same library version.",
    },
    {
      id: 'FE-013',
      requirement:
        'Both dark and light themes render the primary route without unstyled or invisible text.',
      severity: 'medium',
      evidence:
        "resize_window with colorScheme 'light' then 'dark'; screenshot each and confirm body text color differs from its background in both (computed getComputedStyle color !== backgroundColor).",
    },
    {
      id: 'FE-014',
      requirement:
        'The primary user action is reachable purely by clicking from the entry route (no typed URL).',
      severity: 'critical',
      evidence:
        "From the entry route, drive computer left_click through the navigation to the primary action control and complete it; the resulting success node appears in get_page_text.",
    },
    {
      id: 'FE-015',
      requirement:
        'No request on the primary route hangs unresolved (all fetches settle within the timeout budget).',
      severity: 'medium',
      evidence:
        "read_network_requests on the primary route: every request has a terminal status (none in 'pending') within 10s of load.",
    },
    {
      id: 'FE-016',
      requirement:
        'Interactive controls expose an accessible name (no ambiguous icon-only buttons).',
      severity: 'medium',
      evidence:
        "javascript_tool over [...document.querySelectorAll('button,a[href],[role=\"button\"]')]: every element has non-empty textContent, aria-label, or aria-labelledby.",
    },
  ],
});
