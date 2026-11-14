// scenario.ts — the trial's fixed identities.
//
// The scenario is fully deterministic from the constant SCENARIO_SEED in the kit's
// sdk/conformance/wire.ts (buildScenario): the same seed always produces the same viewer,
// teammates and org. The entry therefore hardcodes the viewer it must answer as, rather
// than discovering it at runtime (there is no endpoint that tells the entry who it is).
//
// Verified 2026-11-15 by running the kit's own buildScenario(): viewer is adaiversen.

export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const TEAMMATE = {
  id: 1001,
  login: 'quinnkeller',
  name: 'quinn keller',
  email: 'quinnkeller@example.invalid',
} as const;

/** A real scenario user who is NOT the viewer: any repo under this owner must 404. */
export const STRANGER = {
  id: 1002,
  login: 'olgabauer',
  name: 'olga bauer',
  email: 'olgabauer@example.invalid',
} as const;

export const ORG = {
  id: 2000,
  login: 'faint-meadow-org',
  name: 'faint meadow org',
} as const;

export const DEFAULT_BRANCH = 'main';
