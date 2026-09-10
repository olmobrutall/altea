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

Three places where the comment's *reason* had expired, and **all are CLOSED**. The third turned out to be a
live defect rather than a spelling preference — which is the argument for chasing an expired reason instead
of just rewording it: the comment was wrong about *why*, and the code was wrong too. Pulling that thread
found the same defect in three more modules (§2.4), one of which had a whole search page throwing.

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

### 2.3 ~~altea-workflow's Finder tokens are camelCase literals~~ — FIXED, and it was a live defect

The stated reason had expired: the server's `QueryLogic.getToken` was an exact Map lookup when those
literals were written, and `QueryToken.subToken` falls back to a case-insensitive match now.

**Correcting it uncovered a bug rather than a spelling preference.** A `hiddenColumns`, `rowAttributes` or
`formatters` key is matched EXACTLY — `formatters[qt.fullKey()]`,
`resultTable.columns.indexOf(tokenName)` — against a column name the server echoes as the resolved token's
own `fullKey()` (`queryServer.ts`: `columns: rt.columns.map(c => c.token.fullKey())`). That key is
PascalCase, because `EntityPropertyToken.key` is `fieldInfo.name.firstUpper()`. So on the Inbox:

- the five cell formatters (`"activity"`, `"mainEntity"`, `"actor"`, `"sender"`, `"workflow"`) matched
  nothing and never fired — including `ActivityWithRemarksComponent`, which is the remarks widget, not
  decoration;
- `rowAttributes` asked `tryGetRowValue(row, "state")` against a `State` column, got `undefined`, and fell
  to `default: return {}` — so the Inbox had none of its per-state row colouring.

Both blocks are built with the TYPED token builder now (`token(a => a.doneDate).hasValue()`,
`InboxRowModel.token(a => a.state)`), which spells them canonically and checks them against a field rename.
The five `formatters` keys are the exception and stay string literals — an object key is a string — so they
are the one thing in that block to re-check after a rename, which their comment says.

Verified by serialising every one of them through the real `tokenSequence` against the built output:
`State`, `StartDate`, `Activity`, `MainEntity`, `Actor`, `Sender`, `Workflow`, `DoneDate.HasValue`,
`WorkflowActivity.(WorkflowActivity)`, `WorkflowActivity.(WorkflowActivity).Lane.Pool.Workflow`, `Case`.

### 2.4 ~~A token key compared as camelCase — the same defect in three more modules~~ — ALL FIXED

`altea-workflow` (§2.3) was not the only place written against the OLD convention, when a token key WAS the
camelCase field name verbatim. `EntityPropertyToken.key` is `fieldInfo.name.firstUpper()` now, so every
site that compared or built a token key as a lower-case string was wrong.

**This is SIGNUM'S arrangement, and the repair is a convergence back onto it — not a new rule.** Signum has
the same two vocabularies (a token key from a PascalCase C# property; a camelCase Graph field) and settles
them with one crossing plus consistent literals:

- `ToGraphField` is `token.Follow(a => a.Parent).Reverse().ToString(a => a.Key.FirstLower(), "/")`;
- every token-key comparison in its RemoteEmailsLogic is PascalCase — `"User"`, `"Id"`, `"Entity"`,
  `"Folder"`, `"Extension"`, `"WellKnownFolderName"`.

altea now does exactly that, literal for literal. **The detour is the whole story, and it was
self-inflicted:** while altea's token keys were camelCase, the porter correctly dropped the `FirstLower`
(a no-op then) and correctly lower-cased each of Signum's PascalCase literals. Both were right *for that
convention*. When the keys moved back to PascalCase — the CLAUDE.md token bullet, which brought altea's
token spelling into line with Signum's — the framework was swept and these two modules were not.

So the honest size of it: not a subtle two-vocabulary puzzle, but ~15 sites left behind by a convention
change, in the one module family that had adapted hardest to the old convention. The care needed was in
reading each string for WHICH side it names, because a blind PascalCase sweep would have fixed the
comparisons and broken the field names.

One altea-specific mapping survives, and it is not arbitrary: `MessageId → id`, plus `objectId → id` in the
base. Signum's row models call the member `Id`, so `FirstLower` yields Graph's `id` for free; altea's cannot
— a member named `id` is excluded from a query's token tree — so the rename has to be undone explicitly.

What was fixed, module by module:

- **`altea-alert`** — the `"textField"` formatter key and the SEVEN `getRowValue` reads inside it, which use
  `getRowValue` (it THROWS on a miss), so the Text column's link expansion would have thrown had the
  formatter ever fired. The reads are the typed builder now, and their seven casts went with it: with a
  typed `QueryTokenString<T>` the return type infers, where a bare string left `T` as `unknown`.
- **`altea-tree`** — `TreeViewer`'s three `fullKey()` comparisons, which had stopped dropping the columns
  the tree draws as its own first column, so **the tree page rendered Id, Name and FullName twice**. Plus
  `TreeClient.overrideDefaultOrder`'s order token, canonicalised for consistency.
- **`altea-mailing-microsoft-graph`** — the `"subject"` formatter key and its four reads; `markRowsColumn`
  (matched by `columns.indexOf`, so no row was ever marked); the pinned `user` filter and four hidden
  columns; both `fullKey() === "user"` predicates; a `+ ".emailAddress"` token path; and on the server the
  mailbox `extractFilter` key — which is why **every query threw `UserFilterNotFound`** — plus
  `inMicrosoftGraph`, the `messageId` order guard, the `Folder` collapse and the four `Extension` branches.
- **`altea-auth-azuread`** — `toGraphField`'s lowering and the alias application, for BOTH directory-search
  pages.

**Pinned by a new DB-free suite**, `altea-mailing-microsoft-graph/test/graphFields.test.ts` (10 cases, and
the package gains a `test` script and a `tsconfig.test.json`). It covers both converters, since the message
one extends the base, and it asserts the exact Graph field strings against the documented resource fields —
`subject`, `receivedDateTime`, `from/emailAddress/address`, `parentFolderId`, `id`, `displayName`,
`onPremisesExtensionAttributes`. **Verified to CATCH the regression**: reverting `firstLower()` fails 3 of
the 10.

That suite also retires the reason this was first recorded rather than patched. The `$select` / `$filter` /
`$orderby` strings fail against the live API as an opaque 400, so a tenant looked like the only possible
check — but `toGraphField` is pure given a token, so the names can be held down headlessly, and the target
was never in doubt anyway: it is what Signum sends. What is still NOT verified is whether Graph ACCEPTS
them, i.e. that the documented field list matches the tenant's API version. The strings are fixed in place,
so a tenant that disagrees points at the exact assertion to change.

Not part of this: `altea/test/server/dynamicQueries/expressionContainer.test.ts:109-110` asserts
`t.key === "rootNotes"`. A registered expression's explicit `{ key }` is honoured VERBATIM, so a camelCase
key is legitimate there and those assertions are right.

---

## 3. Unfinished work whose blockers have landed

### 3.1 ~~The template body-text token pass~~ — PORTED (text templates AND office documents)

When a query token is renamed, a template's stored **query** tokens — filters, orders, the From token —
were repaired by the subscriber in each template module, but its **body** was not: `@[Customer.Name]`,
`@foreach[Details] as $d`, `@if[TotalPrice>100]` all kept naming a field that no longer existed, and the
first anyone knew was a parse error when the template rendered.

That pass is `altea-templating/server/TemplateSync.ts` now — Signum's `TemplateSynchronizationContext`
(CommonTemplate.cs) — plus a `synchronize` on **every value provider** (7), **every node** (7) and **every
condition** (3), and `TextTemplateParser.synchronize` as the entry point. @altea/altea-email drives it over
each message's Subject and Text, with ONE context per template so a decision answered for the first culture
is not asked again for the rest.

It is what @altea/altea-user-assets' `Member` and `Global` rename buckets were built for and had no
consumer of.

**The walk MIRRORS `write`** — same order, same variable scoping — and that is not a stylistic choice:
`write` is what turns the tree back into the stored text, so a node that synchronised under a different
scope than it prints under would rewrite a `$var` into one that is not in scope there.

altea divergences, all recorded in the file:

- **no QueryDescription**, so a token is fixed against the QUERY NAME; `queryName === undefined` is what
  "model-only template" means here rather than a null QD.
- **no `forceChange`.** Signum threads it down to `FixToken` for "it resolves, but change it anyway";
  altea DISCOVERS staleness by whether the token resolves, so `fixToken` has no such option — and every
  call site in Signum's own text-template walk passes `false`.
- **the MEMBER bucket only offers candidates for a REFLECTED type.** Signum asks `GetFields()` /
  `GetProperties()` of any CLR type; altea has a member table only where the transformer wrote one, so a
  step whose owner is not reflected is accepted unchanged rather than offered for rename. Inventing
  candidates would be worse — a rename recorded against a guess misfires later, against every template
  sharing the bucket.
- **`NiceNameValueProvider` is a no-op**, as Signum's is: `@[n:Order.ShipDate]` names a member for its
  LABEL and is resolved at parse time into a `() => string`, with no member list to rewrite.

#### A safety net Signum does not have

`synchronize` **self-checks before it touches anything**: it prints the freshly parsed tree and compares it
to the text it came from, and refuses — loudly, naming the template — if they differ.

The reason is specific. A token that fails to RESOLVE is a non-fatal parse error and leaves the tree
complete, which is exactly the state this pass repairs. But a FATAL one — a body with tokens and no query,
an `as $x` colliding with an outer scope — aborts the parse mid-way, and the tree is then a PREFIX of the
template. Signum writes back unconditionally; here that would silently truncate somebody's template
instead of repairing it. Pinned by a case: without the check, a template reading `Hi @[Name]! Bye.` comes
back as `Hi `.

#### Verified

`altea-templating/test/templateRoundTrip.test.ts` — 20 DB-free cases (the package gains a `test` script
and a `tsconfig.test.json`). Seventeen are the parse → `write` round trip, one construct each so a failure
names the node that broke; the rest are `synchronize` itself: a clean template comes back as the ORIGINAL
string (by identity, which is what the callers compare on before writing to the database), an empty body is
returned as it came, and the truncation guard above.

DB-free, and the way it gets there is the point: a token that fails to resolve is a non-fatal error, so an
unregistered query name yields a complete tree full of unresolved tokens — precisely the state a stale
template is in.

#### Office documents — also ported

An office template's `@[Customer.Name]` lives in the .docx/.pptx/.xlsx bytes, and Signum walks those with
the same context over a DIFFERENT tree (`WordTemplateNodes.cs`'s own `Synchronize` per node). That walk is
now `OfficeTemplateNodes`' `synchronize` on each of the six node classes, driven by
`OfficeTemplateTokenSync.synchronizeDocument` — which also brought Signum's THIRD pass with it, the file
name (itself a text template). The repaired bytes go back onto the SAME FileEntity row
(`file.allowChange = true`), one of the three places Signum lifts immutability per instance.

Two things fell out of writing it:

- **the text half was missing a scope.** A block keyword takes TWO, as Signum's does, and altea's text
  nodes had only the inner one — so a `@foreach[$d.Details] as $e`, whose provider DECLARES `$e` while
  synchronizing, leaked `$e` past the `@endforeach`. Fixed in both halves.
- **a claim I wrote in the same turn was wrong and is corrected.** The first version of the node comment
  said a nested node is visited TWICE — once by the driver's sweep, once by its container recursing — on
  the strength of Signum's shape. It cannot be: `replaceBlock` moves a keyword's body into a BlockNode
  that is NOT its child in the document tree, so the driver's `descendantsOfType(BaseNode)` stops at the
  container. Probed, then asserted in the suite (each token asked exactly once) rather than reasoned about
  a second time.

### 3.2 ~~The `TODO(port)` block in `altea/client/Finder.tsx`~~ — TRIAGED

The file was written AHEAD of the UI layers it talks to and said so: *"the API + parse foundation compiles
now and the UI is un-commented as SearchControl/Lines/Operations land."* All three landed. Eighteen markers
were hanging off that expired premise, and the header now says which of two things each one is:

> `TODO(port)` — something Signum does that altea does not do YET.
> `DIVERGENCE` — something altea deliberately does differently, and always will.

**13 TODOs and 3 DIVERGENCEs**, down from 18 undifferentiated markers (45 in the workspace, from 50).

**Re-filed as DIVERGENCE** — permanent differences that were wearing a TODO's clothes, which is the worst
kind: someone eventually "fixes" them back.

- there is no QueryDescription DTO; the token tree is built in the browser.
- Signum's free entity helpers are METHODS here (`toLite`→`e.toLite()`, …), and `MListElement` is gone
  with MList.
- there is no `isDecimalType`, because there is no separate decimal TYPE NAME — the int/long/decimal split
  lives in `subTypeName`.

**Corrected, and still TODO** — the work is real but the recorded reason had expired, which in three cases
made it look bigger than it is:

- **SearchControl / Lines / SearchPage "not ported yet"** — all landed, including `EntityLink`,
  `SearchControlLoaded` (with `SearchControlMobileOptions` / `ColumnParsed`), `clearContextualItems` and
  `clearManualSubTokens`. The remaining work is un-commenting the code that wants them.
- **the `any` aliases** — all three types exist. Nothing structural is in the way either: the file already
  takes `SearchControlLoaded` itself as an `import type`, which is erased and closes no cycle. Each alias
  has exactly ONE consumer, so it is three imports and three signatures.
- **`qs.onFind` / `onFindMany` + the autoSelectIfOne / autoSkipIfZero fast paths** — Signum's full version
  is commented out below the stub, and the `fetchLites` shape it was waiting on now exists.
- **the min/max overflow guard** — recorded as "altea has a single numeric type, so the range check is
  dropped". Wrong: the split lives in `subTypeName` and `numberLimits` in `./numberFormat` IS that map.
  Only the check is missing.
- **the formatter layer**, listed whole and mostly landed: `toNumberFormat` and `numberLimits` exist (the
  first is imported). Still missing: `getEnumInfo`, `onReloadTypesActions`, `toFormatWithFixes`, and the
  date/duration parse+format helpers — which are to be WRITTEN against `Temporal`, not restored from
  luxon, luxon being a recorded non-goal.
- **`similarToken`** and **`Components/ProgressBar`** — genuinely not ported, the only two of the nine
  names that list claimed. (Each ProgressBar consumer keeps a local one; see @altea/altea-machine-learning.)
- **the DateOnly-vs-DateTime distinction** in `tokenCanSetPropery`, which needs the format/route layer.

Also removed: a commented-out `Notify` import made redundant by the live one this session's split-executor
work added, and an "ALTEA STUB … throws until SearchControl lands" note on `findMany`, which has not thrown
since the SearchModal landed.

> Worth recording, because it happened while writing this up: three of the claims in the FIRST pass of these
> rewrites were themselves wrong — `numberLimits` described as already imported (it is not), both message
> containers described as one, and an import cycle blamed for the aliases when a type-only import was
> already in place. Each was caught by grepping the file rather than trusting the sentence being replaced.
> The failure mode this whole page is about does not spare the person fixing it.

### 3.3 ~~Two~~ smaller recorded holes

Not findings of this pass — both were correctly recorded where they live — but they belonged on any list
of loose ends. The first is now closed:

- **~~`EntityTypeToken` is not ported~~ — PORTED.** `data/dynamicQuery/tokens/entityTypeToken.ts` plus the
  `PreAnd` on both polymorphic branches. It turned out to be navigation and nothing else: the
  discriminator is already a column on either shape, and both halves of the path (`lite.entityType` →
  a Type expression, `.toTypeEntity()` → the TypeEntity row) were already in the binder for other
  callers — so the token adds no SQL. Two things fell out of writing it: the `@implementedByAll` branch
  was missing `HasValue` as well (the comment recorded that fix for the `@implementedBy` branch only),
  and `data/typeEntity`'s header still said `toString()` was left as the inherited default when the
  `@quoted toString() => cleanName` twelve lines below it says otherwise — which matters here, because
  that expression is what gives the new lite its display string.
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
| altea-office-template | a nested node is visited TWICE, by the driver and by its container | a container's body is detached from the tree, so the driver never reaches it — mine, corrected in the same turn |
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
| altea/data | `typeEntity.ts`: "`toString()` is left as the inherited default rather than `CleanName`" | the `@quoted toString() => cleanName` twelve lines below it — found while porting `[EntityType]`, whose lite reads that display string |
| altea/data | `queryToken.ts`: the `@implementedByAll` branch, silent about HasValue while the sibling branch's comment claims the fix | it had neither HasValue nor the type token — see §3.3 |

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
