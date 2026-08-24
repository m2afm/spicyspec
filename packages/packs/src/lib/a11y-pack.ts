// a11y-pack.ts
// -----------------------------------------------------------------------------
// The "a11y-checklist" gate pack. It joins the gate for the `execute` and
// `converge` pipeline stages under the `a11y-reviewer` seat. Every item is a
// WCAG 2.2 Level AA essential (text alternatives, labeled controls, contrast,
// visible focus, keyboard operability, heading order, landmarks, valid ARIA,
// reduced-motion, page language, WCAG 2.2 target size, and programmatic error
// identification) and carries CONCRETE evidence: an axe-core rule to run, a
// keyboard sequence to perform, or a computed ratio/attribute to read. None of
// these can be ticked by inspection alone -- each names the exact automated
// check, manual interaction, or measured value that proves it true.
// -----------------------------------------------------------------------------

import { parsePack, type GatePack } from './pack.js';

export const a11yPack: GatePack = parsePack({
  id: 'a11y-checklist',
  name: 'Accessibility checklist',
  stages: ['execute', 'converge'],
  seat: 'a11y-reviewer',
  execute: true,
  items: [
    {
      id: 'A11Y-001',
      requirement:
        'Every informative image has a meaningful text alternative (WCAG 1.1.1).',
      severity: 'critical',
      evidence:
        "axe-core scan on the primary route reports zero violations of rule 'image-alt'.",
    },
    {
      id: 'A11Y-002',
      requirement:
        'Every form control has a programmatically associated label (WCAG 1.3.1, 4.1.2).',
      severity: 'critical',
      evidence:
        "axe-core scan reports zero violations of rules 'label' and 'select-name'; each input resolves a non-empty accessible name in the accessibility tree.",
    },
    {
      id: 'A11Y-003',
      requirement:
        'Body text meets a 4.5:1 contrast ratio against its background (WCAG 1.4.3).',
      severity: 'critical',
      evidence:
        "axe-core rule 'color-contrast' reports zero violations; spot-check computed ratio of body text vs background >= 4.5 in devtools contrast inspector.",
    },
    {
      id: 'A11Y-004',
      requirement:
        'Large text (>=24px, or >=18.66px bold) meets at least a 3:1 contrast ratio (WCAG 1.4.3).',
      severity: 'high',
      evidence:
        "devtools contrast inspector on each large-text node reports a computed ratio >= 3.0; axe-core 'color-contrast' reports no large-text violations.",
    },
    {
      id: 'A11Y-005',
      requirement:
        'A visible focus indicator appears on every interactive element when focused (WCAG 2.4.7).',
      severity: 'high',
      evidence:
        "Tab through every interactive element via computer key 'Tab'; screenshot each focused state and confirm a visible focus ring (outline/box-shadow differs from the unfocused computed style).",
    },
    {
      id: 'A11Y-006',
      requirement:
        'All functionality is operable by keyboard alone with no keyboard trap (WCAG 2.1.1, 2.1.2).',
      severity: 'critical',
      evidence:
        "Using only Tab/Shift+Tab/Enter/Space/Escape, reach and activate the primary action and exit any dialog; confirm focus never becomes stuck (document.activeElement keeps advancing).",
    },
    {
      id: 'A11Y-007',
      requirement:
        'Heading levels are used in order without skipping a level (WCAG 1.3.1).',
      severity: 'medium',
      evidence:
        "javascript_tool: read [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => +h.tagName[1]) and assert no step increases by more than 1; axe-core 'heading-order' reports zero violations.",
    },
    {
      id: 'A11Y-008',
      requirement:
        'The page exposes the required landmark regions (main, and banner/contentinfo where present) (WCAG 1.3.1).',
      severity: 'high',
      evidence:
        "axe-core rules 'landmark-one-main' and 'region' report zero violations; read_page shows a single main landmark containing the primary content.",
    },
    {
      id: 'A11Y-009',
      requirement:
        'All ARIA roles, states, and properties are valid and permitted for their element (WCAG 4.1.2).',
      severity: 'high',
      evidence:
        "axe-core rules 'aria-valid-attr', 'aria-valid-attr-value', 'aria-roles', and 'aria-required-attr' all report zero violations.",
    },
    {
      id: 'A11Y-010',
      requirement:
        'Non-essential motion and animation is disabled under prefers-reduced-motion (WCAG 2.3.3).',
      severity: 'medium',
      evidence:
        "Emulate prefers-reduced-motion: reduce in devtools rendering, reload, and confirm via getComputedStyle that animation-duration/transition-duration resolve to ~0s on animated elements.",
    },
    {
      id: 'A11Y-011',
      requirement:
        'The document declares a valid primary language (WCAG 3.1.1).',
      severity: 'high',
      evidence:
        "javascript_tool: document.documentElement.lang matches a valid BCP-47 tag (e.g. /^[a-z]{2}(-[A-Z]{2})?$/); axe-core 'html-has-lang' and 'html-lang-valid' report zero violations.",
    },
    {
      id: 'A11Y-012',
      requirement:
        'Pointer target size is at least 24x24 CSS pixels, or has sufficient spacing (WCAG 2.2, 2.5.8).',
      severity: 'medium',
      evidence:
        "javascript_tool over interactive controls: each element's getBoundingClientRect() width >= 24 and height >= 24 (or documented spacing exception); axe-core 'target-size' reports zero violations.",
    },
    {
      id: 'A11Y-013',
      requirement:
        'Input errors are identified programmatically, not by color alone (WCAG 1.4.1, 3.3.1).',
      severity: 'high',
      evidence:
        "Submit an invalid form and confirm the field has aria-invalid=\"true\" and an aria-describedby error node with text; the error is conveyed by text/icon, not color only (verify in read_page tree).",
    },
    {
      id: 'A11Y-014',
      requirement:
        'The full-page automated accessibility scan reports zero critical or serious violations (WCAG 2.2 AA baseline).',
      severity: 'critical',
      evidence:
        "Run axe-core (or `npx @axe-core/cli <url> --tags wcag2a,wcag2aa,wcag21aa,wcag22aa`) on the primary route; the results array contains zero entries with impact 'critical' or 'serious'.",
    },
  ],
});
