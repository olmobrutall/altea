# Open questions, loose ends, and the stale-claim ledger

This page is the by-product of the comment-redundancy pass that produced the per-module ledgers in this
directory. That pass read every `Signum` reference in fifteen modules and asked one question of each:

> Would this comment still be true and useful if `old/` were deleted?

Most answers were "no, but it is worth keeping somewhere" — that is what the ledgers are for. A minority of
answers were **"no, because it is not true any more"**, and those are what this page collects: the claims
that had expired, the gaps whose stated reason had expired, and the work whose blockers have since landed.

Nothing here is a comment problem. Each item is a decision, a defect, or a piece of unfinished work that a
comment happened to be sitting on top of.

---

## 1. Live defect: a reachable `throw` behind an expired TODO

**`altea/client/Finder.tsx:2115`.** `executeQuerySplitTimeSeries` throws unconditionally:

```ts
// TODO(port): the time-series split executor needs luxon DateTime (dropped in altea — use
// Temporal), Notify/NotifyOptions/JavascriptMessage (notification UI not ported) and
// "AsOf" slicing. Restore from the Signum source once those land.
export async function executeQuerySplitTimeSeries(request: QueryRequest, signal?: AbortSignal): Promise<ResultTable> {
  throw new Error("TODO(port): executeQuerySplitTimeSeries — luxon DateTime + Notify not ported");
}
```

**It is reachable, and not obscurely.** `Finder.executeQuery` dispatches to it (`Finder.tsx:2121`):

```ts
if (request.systemTime?.mode == "TimeSeries" && request.systemTime.splitQueries)
  return executeQuerySplitTimeSeries(request, signal);
```

and `splitQueries` is a **user-facing checkbox** — `altea-chart/client/Templates/ChartTimeSeries.tsx:145`,
plus `ChartBuilder.tsx:116` which sets it to `true`. It round-trips through the chart URL
(`ChartClient.tsx:621` / `:722`), so a saved or shared chart carries it too. Ticking that box on a chart's
time-series panel is a hard runtime failure.

**Every stated blocker has landed:**

| The TODO says | Reality |
| --- | --- |
| "needs luxon DateTime" | luxon is a recorded non-goal; `Temporal` is the substrate, and the TODO itself says to use it |
| "Notify/NotifyOptions … not ported" | `altea/client/Frames/Notify.tsx` exists |
| "JavascriptMessage … not ported" | `altea/data/uiMessages.ts:40` exports it |

So the remaining work is the executor's own body — the `AsOf` slicing — not its dependencies.

**TODO:** either implement the split executor, or make the failure honest. Right now `executeQuery` looks
total and is not. If it stays unimplemented, the checkbox should not be offerable: gating it in
`ChartTimeSeries` costs one line and converts a stack trace into a control that isn't there.

---

## 2. Parity gaps left as code, on purpose

Three places where the comment's *reason* had expired but the *code* is a judgement call I did not want to
make blind. In each the comment now names the gap instead of denying the seam exists; the decision is open.

### 2.1 A `@notVisible` member is offered as a dynamic-view node

**`altea-dynamic/client/View/Nodes.tsx:1695`.** `appropiateComponent` skips `id` and `@serialize(false)`
members. Signum skips those **and** anything `notVisible`. The comment used to say "altea has no
notVisible"; `FieldInfo.notVisible` landed in `altea/data/reflection.ts:350` with the altea-tree port.

The fix is one predicate (`fi.noSerialize || fi.notVisible`). I left it because it changes what the designer
offers, and "what the designer offers" is worth a deliberate call rather than a drive-by.

**TODO:** add `notVisible` to the skip, or record why altea deliberately offers what Signum hides.

### 2.2 `modules.TreeClient` is not offered to interpreted views

**`altea-dynamic/client/View/GlobalModules.ts:27`.** The header said "`TreeClient` is dropped: Signum.Tree
is not ported." @altea/altea-tree **is** ported, so a Signum dynamic view reaching for `modules.TreeClient`
fails for a reason that no longer exists.

The key is still not offered, and that is the actual question: adding it makes altea-dynamic depend on
altea-tree. `globalModules` is the API surface an interpreted view writes against, and keeping the KEYS
identical to Signum's is what lets a Signum view paste in and resolve — which argues for adding it. Against:
a dependency from the "define the app from the app" module onto an optional feature module.

**TODO:** decide the dependency. If yes, the key is a one-line addition; if no, the header should say the
dependency is the reason, which it now does.

### 2.3 altea-workflow's Finder tokens are camelCase literals

**`altea-workflow/client/WorkflowClient.tsx:218`** (the CaseActivity settings) and **`:243`** (the Inbox).
The stated reason was that the server's `QueryLogic.getToken` was an exact Map lookup, so a PascalCase token
could not reach it. `QueryToken.subToken` now falls back to a case-insensitive match
(`altea/data/dynamicQuery/tokens/queryToken.ts:164`), so both spellings resolve on both tiers, and the
canonical spelling is Signum's (`Case`, `DoneDate.HasValue`).

I left the literals because the `formatters` and `hiddenColumns` keys beside them are matched against a
resolved token's own `fullKey()`, so re-spelling the tokens means re-checking those keys — a browser check,
not a comment edit.

**TODO:** re-spell the tokens to the canonical PascalCase and verify the Inbox's five cell formatters and its
hidden `state` column still bind. Low risk, but it needs the app running.

---

## 3. Unfinished work whose blockers have landed

### 3.1 The template body-text token pass

**`altea-templating/server/TemplateUtils.ts:17`** already carries the corrected note, so this is a pointer
rather than a discovery: when a query token is renamed, a template's stored **query** tokens (filters,
orders, the From token) are repaired, but a renamed token inside the **body text** — `@[Customer.Name]` —
still surfaces as a parse error when the template renders.

The recorded reason used to be that altea had no TokenMigrations. @altea/altea-user-assets now provides
every prerequisite (`TokenMigrationLogic` / `QueryTokenSynchronizer` / `TokenSyncContext`). What is missing
is this module's own half: Signum's `TemplateSynchronizationContext` plus a `Synchronize` on every value
provider, which is what the `Member` / `Global` buckets exist for.

**TODO:** port that half. It is the last known hole in the token-migration story.

### 3.2 The `TODO(port)` block in `altea/client/Finder.tsx`

52 `TODO(port)` markers survive in the workspace; **20 of them are in this one file**, hanging off a header
whose premise expired long ago:

```
// PORT (Signum.React/Finder.tsx, copy-and-fix): ported deps are retargeted to altea paths; deps not
// yet ported are commented `// TODO(port): …` and the code using them is commented likewise, so the
// API + parse foundation compiles now and the UI is un-commented as SearchControl/Lines/Operations land.
```

All three landed: `altea/client/SearchControl/`, `altea/client/Lines/`, `altea/client/Operations/`. Fourteen
commented-out imports and markers like "SearchControl not ported yet" (`:66`), "Lines not ported" (`:72`),
"SearchPage not ported yet" (`:312`) and "typed against SearchControlLoaded once SearchControl lands"
(`:318`) all describe a state that has not been true for a long time.

They are not uniformly stale, and that is the work:

- **stale** — the five above, plus `:125`'s "types owned by not-yet-ported modules".
- **mislabelled** — `:31` (QueryDescriptionDTO dropped) and `:473` (no `isDecimalType`) are permanent,
  *recorded* divergences wearing a TODO's clothes. They should read as divergences, so nobody "fixes" them.
- **real** — the luxon date/duration parse+format restoration (`:6`), `similarToken` (`:1126`),
  `numberLimits` (`:1348`), and the split executor of §1.

**TODO:** triage the 20 into those three buckets and re-file each. A TODO that cannot come true is worse than
no TODO: it trains a reader to skip the ones that can.

### 3.3 Two smaller recorded holes, unchanged

Not findings of this pass — both are correctly recorded where they live — but they belong on any list of
loose ends:

- **`EntityTypeToken` is not ported** on a polymorphic reference (a `phase3c` TODO). altea offers casting
  and `HasValue` where Signum also offers the type token, so this divergence runs the *other* way from most.
- **The `@part` EntityData facet has no consumer.** Nothing in altea reads it yet — it is Signum-parity
  metadata, used there by the sync and the schema map. CLAUDE.md notes that is where to look first if a
  consumer appears.

---

## 4. The stale-claim ledger

Every claim this pass found false, with what it said and what was true. All are **corrected**; the table is
evidence for §5, and a record so the same sentence is not re-derived from `old/` later.

| Module | The claim | What was true |
| --- | --- | --- |
| altea-view-log | a core gap blocked something | the gap had been fixed |
| altea-diff-log | — | three comments disagreed with each other three ways |
| altea-tour | a translations registry it read from | no such registry ever existed |
| altea-markdown | Signum's `markdownOption` mattered | it is dead code in Signum |
| altea-toolbar | `ToolbarXml` is "a plain rebuild … rows carry no identity beyond `guid`" | it uses `syncRows`, matching BY ID |
| altea-templating | `@[t:…]` "needs Signum's PropertyRouteTranslationLogic, which altea has no counterpart for" | `altea/server/propertyRouteTranslation.ts` exists |
| altea-templating | the body-text sync pass is impossible (no TokenMigrations) | every prerequisite had landed — see §3.1 |
| altea-auth | `AuthLogic`: "lands in Phase 4" | it had landed |
| altea-auth | `AuthLogic`: `withDisabled` "is a NO-OP until the authorization engine exists" | 20 lines above a body documenting it suppressing the row filter, the save gate and `isAllowedFor` |
| altea-auth | `Rules.ts`: "this first slice", "land with the Type-authorization slice", "are Phase 5", "Property auth waits on a PropertyRouteEntity port" | all four are in that file |
| altea-auth | `TypeAuthLogic`: "row filter + save gate are Phase D" | installed on `schema.queryFilterProviders` |
| altea-auth | `TypeConditionLogic`: `_TypeConditions` "lands with the enforcement phase" | the WeakMap is 30 lines below |
| altea-auth | `AuthServer`: reflection "belongs to Phases 4-5 and is intentionally absent" | `start()` calls `AuthReflectionServer.install()` |
| altea-auth | `PermissionAuthLogic`: "rule-pack admin + XML are Phase 5" | both present |
| altea-auth | `AuthImportExport`: "(no PropertyRouteEntity)" | there is one |
| altea-auth | `AuthClient.tsx`: "UserTicket cookie login is deferred (`registerUserTicketAuthenticator` is a seam)" | 190 lines above the implemented registrar and `loginFromCookie` |
| altea-office-template | `TokenMigrationLogic` "is not ported; altea has no such subsystem" | line 41 imports it; line 105 registers `OfficeTemplateTokenSync` |
| altea-office-template | "no template-sync in altea" (×2 files) | there is |
| altea-office-template | `OfficeTemplateXml`: "altea's is a `FileEmbedded`" | it is `template: FileEntity`, line 163 |
| altea-workflow | `CaseActivityLogic`: `PackageExecuteAlgorithm<CaseActivityEntity>` "has no altea counterpart" | `altea-processes/server/PackageLogic.ts:183` |
| altea-workflow | `WorkflowLogic`: `PropertyRouteTranslationLogic.RegisterRoute` "has no altea counterpart yet" | it has one |
| altea-workflow | `WorkflowLogic`: `EvalLogic.GetCustomErrors` / `OnInvalidated` "go with the Eval deferral" | Eval is ported; those two are declined on their own merits |
| altea-workflow | `data/Workflow.ts`: a bold heading, "**Evals become SYMBOLS.**" | above its own body explaining that all eight port as evals |
| altea-workflow | `WorkflowClient`: the server's token lookup is exact-match | it has a case-insensitive fallback — see §2.3 |
| **altea-dynamic** | **a 36-line header: the seven COMPILED features are "NOT ported", "a design project, not a port"** | **the same file's `compileDynamicCode` compiles them** |
| altea-dynamic | same header: "Signum.Eval does not port either (it IS the Roslyn host)" | @altea/altea-eval is ported, and this module depends on it |
| altea-dynamic | same header: `DynamicPanelPermission.RestartApplication` "is dropped: there is no compilation step to restart for" | 81 lines below, `PermissionLogic.registerPermissions` registers it |
| altea-dynamic | `DynamicClient` / `DynamicViewClient` / `View/FieldExpression`: three re-homings, each "because Signum.Eval does not port" | the re-homings are right; TypeHelp is what does not port |
| altea-dynamic | `View/Nodes.tsx`: "altea has no notVisible" | it does — see §2.1 |
| altea-dynamic | `View/GlobalModules.ts`: "`TreeClient` is dropped: Signum.Tree is not ported" | altea-tree is ported — see §2.2 |
| altea/client | `Finder.tsx`: "the UI is un-commented as SearchControl/Lines/Operations land" | all three landed — see §3.2 |

---

## 5. The pattern, and the two rules that follow

Across every module in the pass, **not one stale comment described the line it sat on.** Each described one
of exactly two things:

1. **another file's or module's behaviour** — which the author of *this* file does not control and will not
   be editing when it changes; or
2. **the plan** — "Phase 4", "Phase D", "this first slice", "lands with…", "not ported yet".

A progress note goes stale by being **acted on**, which is the one thing you can rely on happening to it. A
comment that says "not yet" is a comment that will be wrong, and the more accurate it was when written the
longer it survives unread afterwards.

Worse, the four most misleading cases had **already been corrected somewhere else** while the module's own
header went on saying the old thing — altea-office-template, altea-workflow (twice), and altea-dynamic,
where CLAUDE.md *and* the package's own `data/DynamicPanel.ts` both contradicted `server/DynamicLogic.ts`.
A reader who consults one home gets one answer.

Two rules follow, and both are already how the ledgers are organised:

- **One home per fact.** A cross-cutting narrative lives in `docs/port/<Module>.md`; a file's comment
  describes the file. Duplication is how the two get to disagree.
- **A comment may describe the code or the world, never the schedule.** "Not ported" is a fact about the
  world and belongs in the ledger's *Not ported* section, where it is reviewed. "Phase 4" is a schedule and
  belongs in an issue tracker, or nowhere.

---

## 6. Checked, and fine

Recorded so the next pass does not re-derive them:

- **The `wf3.json` miss.** A `data/Workflow.ts` rewrite did not apply because the target text was only in
  `WorkflowNodes.ts`. The file's five surviving references are all legitimate (a wire fact, a Signum
  declaration fact, a gap marker) — nothing was missed.
- **`server/PredictorAlgorithm.ts`'s control bytes — fixed.** `objectArrayKey`'s separator and null sentinel
  were RAW `U+0001` and `U+0000` bytes, which made the file binary to grep, ripgrep and every other tool
  that scans the tree; this pass could not read it until they were escaped to `\u0001` / `\u0000`. The
  compiled string is byte-identical. Worth knowing as a class of problem: a literal control character in
  source silently removes a file from every text tool.
- **`Encodings.ts` keeps more Signum references than any other file in the pass, deliberately.** A
  mis-scaled column trains a worse model with no error anywhere, so the reference implementation IS the
  specification there — including the two places this port deliberately diverges (the z-score guards a zero
  standard deviation where Signum divides and yields NaN; an empty set's defaults are the identity).
