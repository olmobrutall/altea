# @altea/altea-auth-test

Server-side tests for the **authorization** engines in `@altea/altea-auth` (Type / Permission / Operation /
Query / Property + type conditions + the cross-role merge). Mirrors `@altea/altea-test`: a real database,
the Node built-in test runner, the quote-transformer via `tspc`/`register.mjs`.

## Layout

- `data/sample.ts` — a tiny fixture domain: `SampleEntity` (a hidable `secret`, a `confidential` flag), two
  operations (`SampleOperation.Save/Delete`), two row-level conditions (`SampleTypeCondition.Public/Confidential`).
- `server/AuthTestStarter.ts` — registers the sample domain + the full auth stack (eastwind's order).
- `server/setup.ts` — `start()` (connect + build schema), `generateAuthEnvironment()` (DDL + the role/rule
  **fixture**), and the test helpers: **`asRole(role, fn)`** (impersonate — sets the current role via
  `UserHolder`), `role(name)`, `resetAuthCaches()`.
- `server/authRules.test.ts` — the initial suite.

## Running

The DB is **dedicated** (its schema is dropped + regenerated). Never point it at the altea-test or eastwind DB.

1. Copy `.env.example` → `.env.postgres` (or `.env.sqlserver`) and set `ALTEA_AUTH_TEST_DB`.
2. Seed once: `pnpm --filter @altea/altea-auth-test gen:postgres`
3. Run: `pnpm --filter @altea/altea-auth-test test:postgres`

Without `ALTEA_AUTH_TEST_DB` the suites are skipped (they still compile — the stable-API gate).

## The seeded fixture (setup.ts `seed()`)

| Role | Merge | Inherits | Sample rules |
| --- | --- | --- | --- |
| `Super` | Intersection | — | (none → default-allowed TRUE) |
| `Base` | Union | — | (none → deny-by-default) |
| `Sales` | Union | Base | type **Read**, `secret` **None**, `Save` **Allow** |
| `Manager` | Union | Sales | type **Write**, `secret` **Read** (inherits `Save`) |
| `Restricted` | Union | — | type **None**, condition **[Public] → Read** |

## Suggested test cases

Covered by `authRules.test.ts` today: default-allowed roots, the type dimension, operation +
inheritance/auto-propagate, per-instance type conditions, and property hide/read-only/coerce.

Worth adding next:

**Roles & merge**
- Union merge = MAX across parents; Intersection = MIN (a role inheriting one Allow + one Deny parent).
- Diamond inheritance (a role reached through two paths) resolves once, no double-count.
- `isTrivialMerge` roles are skipped in `rolesInOrder(false)`.
- A cycle in `inheritsFrom` is rejected by `loadRoleGraph` (feedback-edge-set throws).
- Changing a role / rule invalidates the caches (save fires the `globalLazy` reset) — assert a value flips
  after a mutating save (inside `Transaction.noCommit` + `resetAuthCaches()`).

**Type conditions**
- Cross-role merge of *conditioned* rules: the 2^n `mergeWithConditions` truth-table (parents with
  DIFFERENT symbol sets) minimises to the expected rule set — Union vs Intersection.
- Last-match-wins: two overlapping condition rules; the later one wins for a row matching both.
- Multi-symbol AND: a rule keyed on `[A, B]` applies only when both hold.
- The save gate (`preSaveGates`): saving a row a condition denies-writing throws `UnauthorizedAccessException`;
  saving an allowed row succeeds (`Transaction.noCommit`).
- The row-read FILTER: `table(SampleEntity)` under `Restricted` returns only Public rows (needs seeded rows;
  exercises the LINQ `queryFilter` lowering to SQL, not just the in-memory `isAllowedFor`).

**Auto-propagate / coerce (the property⇄type + query⇄type coupling)**
- A property with NO rule follows the type's UI-read (already tested for a scalar type); also assert it
  follows a *conditioned* type (property inherits the condition sub-rules per instance).
- Coerce cap: an explicit property rule ABOVE the type ceiling is clamped down per instance (set `secret`
  Write on a role whose type is only Read → serialized as read-only, not writable).
- Query auto-upgrade: a query with no rule is `Allow` iff its root type is UI-readable for the role, else
  `None` (assert `getQueryAllowedByKey` / the reflection-blob query drop).
- Type-read auto-upgrade cascades: making a type unreadable hides its queries AND its properties.

**Operation dimension**
- `DBOnly` vs `Allow`: `isOperationAllowed(inUserInterface:true)` is false for DBOnly but the execute-time
  gate (`inUserInterface:false`) allows it.
- Conditioned operation rule: `Save` allowed only for Public rows (fallback None + [Public] → Allow),
  denied for a Confidential entity — evaluated against the operated instance.
- Construct / no-entity operations evaluate the `fallback` (no instance to test).

**Property serializer write-gate**
- The implicit-retrieve deserializer keeps a read-only / hidden property at its stored value when a client
  posts a changed one (overlay onto the DB original) — round-trip `Serializer.parse` with a `resolve`.

**Permission dimension**
- `isAuthorized(permission)` merges across the role graph (Union any-allow / Intersection all-allow) and
  honours default-allowed.
