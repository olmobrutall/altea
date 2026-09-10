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

## 1. ~~Live defect: a reachable `throw` behind an expired TODO~~ — FIXED

`Finder.executeQuerySplitTimeSeries` threw unconditionally behind a TODO naming three blockers that had all
landed (luxon → `Temporal`; `Frames/Notify.tsx`; `uiMessages`' `JavascriptMessage`). It was reachable from a
user-facing checkbox — `altea-chart/client/Templates/ChartTimeSeries.tsx:145`, with `ChartBuilder.tsx:116`
setting it `true` — which round-trips through the chart URL, so a saved chart carried it.

**It is implemented.** A TimeSeries request now runs one `AsOf` query per date in the series, combined into
one ResultTable with the date prepended as the `TimeSeries` column. The series arithmetic is its own module,
`altea/data/dynamicQuery/timeSeriesDates.ts`, with a 10-case suite
(`altea/test/client/timeSeriesDates.test.ts`) — split out for the reason `client/Basics/changeLogMerge` was:
Finder imports the ajax layer, and this is pure arithmetic that must agree with a SQL function.

Three deliberate divergences from Signum's own client, each pinned by a case:

- **the series INCLUDES `endDate`.** Signum's walk is `while (dt < endDate)`, but its own `GetDatesInRange`
  UDF is inclusive on both dialects, and `test/server/schema/systemTime.test.ts` pins that — a 2-second
  window stepping by 1 second is 3 rows, "0s, 1s, 2s". Signum's client and its own SQL disagree by one point
  at the endpoint; this follows the SQL.
- **the series is ANCHORED (`start + n·step`), not accumulated.** Accumulating re-anchors each step on the
  previous CLAMP, so a month-end series drifts backwards: from Jan 31 by the quarter, Signum gives Apr 30 →
  Jul 30 → Oct 30, and by the month over two years it slides to the 28th and stays there. Found by a test
  whose expectation was written before the implementation.
- **`Quarter` is 3 MONTHS.** `Temporal.Duration` has no quarters, where luxon does, so the unit is mapped
  explicitly rather than lower-cased into a duration key.

### Two things this turned up

**The unsplit TimeSeries path does not exist on the server.** `altea/server/queryServer.ts`'s
`parseSystemTime` switches on the mode and has no `TimeSeries` case, so it throws *"SystemTime mode
'TimeSeries' is not supported"*; its own header records the decision. The SQL substrate IS ported and tested
(`server/queryTimeSeries.ts`'s `GetDatesInRange` UDF, exercised by `test/server/schema/systemTime.test.ts`),
but nothing wires it into a query request, and `includeGetDatesInRange` is called only by the framework's
own test fixture.

So `splitQueries` is not the optimisation it is in Signum — where it trades one `GetDatesInRange`-joined
query for N simple ones — it is **the whole feature**. With the executor implemented, the checkbox is now
the supported path rather than the broken one.

**TODO:** decide whether the server-side path is wanted. It needs `parseSystemTime` to accept the mode and
the dynamic-query layer to join `getDatesInRange`, and it would then have to answer the same series this
client walk does — which the shared expectations above are what to hold it to. If it is not wanted, the
checkbox should stop reading as an optimisation toggle.

**`decompress` is not idempotent, and Signum decompresses each step twice.** Signum writes
`decompress(await executeQuery(...))` while its `executeQuery` already decompresses. `decompress`
substitutes `row.columns[i]` out of `uniqueValues` without clearing them, so a second pass re-indexes with
the real value. The port decompresses once; the comment says so, because the missing call otherwise reads
like an omission.

---

## 2. Parity gaps whose stated reason had expired

Three places where the comment's *reason* had expired. Two are now CLOSED; the third is a decision that
still needs the app running.

### 2.1 ~~A `@notVisible` member is offered as a dynamic-view node~~ — FIXED

`altea-dynamic`'s `appropiateComponent` skipped `id` and `@serialize(false)` members but not `notVisible`,
where Signum skips all three. The comment said "altea has no notVisible"; `FieldInfo.notVisible` had landed
with the altea-tree port, on the COMPILE-TIME descriptor, so the client has it.

It skips `notVisible` now, which makes the view designer the third consumer to honour it after
`AutoComponent` (the auto-generated view) and `EntityTable`'s default columns — the two the core seam was
added for. Two further mentions of the same expired claim, in that file's module header and in
`appropiateComponent`'s own doc comment, went with it.

The two halves of the predicate are not the same kind of rule, which is worth keeping straight: skipping
`@serialize(false)` is **load-bearing** (those internals have no PropertyRoute, so a generated tree
containing them fails at RENDER time), while `notVisible` is cosmetic — a field an app declared an
implementation detail.

### 2.2 ~~`modules.TreeClient` is not offered to interpreted views~~ — FIXED

The header said "`TreeClient` is dropped: Signum.Tree is not ported", so a Signum dynamic view reaching for
`modules.TreeClient` failed for a reason that had stopped being true.

**The key is offered now, and the dependency is real and static** — `@altea/altea-tree` added to
altea-dynamic's package.json and to its client project references. That follows Signum, which imports
`TreeClient` into `GlobalModules` directly, and this package's own precedent: it already reaches statically
across to `@altea/altea-auth` for `AuthClient`, plus eval, files, isolation, codemirror and migrations. The
admin surface is what this module IS.

The alternative considered and rejected was a registration seam (`registerGlobalModule`, filled by
altea-tree's own `start`), which would have inverted the dependency. It loses the property that makes
`globalModules` work at all: the keys are an API surface a pasted Signum view resolves against, and a key
that exists only when its module happens to be installed is a worse contract than one that is always there.

No cycle: altea-dynamic's transitive closure is 14 packages and none of them reaches back to it. Verified in
the running client — `globalModules` has 17 keys, `TreeClient` among them with its real members.

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

50 `TODO(port)` markers survive in the workspace; **18 of them are in this one file**, hanging off a header
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
- **real** — the luxon date/duration parse+format restoration (`:6`), `similarToken` (`:1126`) and
  `numberLimits` (`:1348`). The split executor was the fourth, and §1 closed it: its two markers are gone,
  so 18 remain in this file and 50 in the workspace.

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
