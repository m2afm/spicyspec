export * from './lib/pack.js';
export { frontendPack } from './lib/frontend-pack.js';
export { a11yPack } from './lib/a11y-pack.js';
export { backendPack } from './lib/backend-pack.js';
export { securityPack } from './lib/security-pack.js';

import { frontendPack } from './lib/frontend-pack.js';
import { a11yPack } from './lib/a11y-pack.js';
import { backendPack } from './lib/backend-pack.js';
import { securityPack } from './lib/security-pack.js';
import type { GatePack } from './lib/pack.js';

/** Every bundled pack, by id — the built-in half of the future marketplace. */
export const BUILTIN_PACKS: Record<string, GatePack> = {
  'frontend-checklist': frontendPack,
  'a11y-checklist': a11yPack,
  'backend-checklist': backendPack,
  'security-checklist': securityPack,
};
