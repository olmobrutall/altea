# Gaps the translation audit found

`convert-translations` copies Signum's translation files onto altea's packages; `stub-translations` then
rewrites each file from what the running process actually DECLARES, dropping the rest. Everything Signum
describes and altea does not is therefore a line the sync deletes — and reviewing those deletions one by
one turned out to be a cheap, systematic way to find what the port still owes.

This file is the backlog that review produced. Each item names the Signum original, what altea has today,
and what "done" means. They are independent unless a **Depends on** line says otherwise.

Conventions: read [`AGENTS.md`](../AGENTS.md) first. After changing anything a package declares, re-run

```
pnpm --filter eastwind terminal local stub-translations @altea/<package>
```

and fill the `Description=""` it leaves, taking the German/Spanish from the matching Signum file under
`old/Framework/**/Translations/` whenever the name existed there.

---

## Closed by the audit itself

- **Orphan `msg()` containers.** A container registers when its module is IMPORTED, and
  `localizableTypes()` reads the live registry — so one imported only by client code was invisible to the
  sync, which then rewrote the package file without it and deleted its translations. Fixed by a server-side
  side-effect import in `altea/server/index.ts` (`searchHelpMessages`), `altea-cache/server/CacheLogic.ts`
  and `altea-profiler/server/ProfilerLogic.ts`. **`altea-html-editor` is still open — see A7.**
- **Case-sensitive member lookup.** Signum spells message members camelCase (`JavascriptMessage.cancel`),
  altea PascalCase (`Cancel`); `importXml` matched exactly, so the sync stubbed the altea name and dropped
  the Signum one. `storedMember` in `LocalizedPackage.ts` now probes both and normalises on rewrite.
- **`Altea.de.xml` was never converted.** `convertOne` asks before overwriting an existing target and that
  one file was answered "no", so the German core file was 496 keys short of every other target.

---

## Found while porting these items — separate, still open

### F1 — a `@quoted` method's caption CANNOT come from `nicePropertyName`
`nicePropertyName` resolves through `Localization.Internal.memberNiceName(declaringType, member)`, which
probes the member camelCase and PascalCase — never Signum's name, and never through
`@legacyPropertyRoute`. And `stub-translations` builds a type's member list from
`routeMemberNames` → `PropertyRoute.memberPaths`, i.e. from **fields**, so a `@quoted` method gets no
`<Member>` entry at all and one added by hand is deleted on the next sync.

So a registered expression's caption must be a `msg()` member (the `OperationMessage.SystemValidFrom`
pattern), never `nicePropertyName` over the method. Every `Duration` token now follows that. **If you add
a registered expression, this is the rule.** A doc comment on `@legacyPropertyRoute` saying so would stop
the next person rediscovering it.

### F2 — a null-first ternary in a `@quoted` body is rejected, with a misleading error
`ConditionalExpression.calculateType` (`altea/server/linq/expressions.ts:1089`) is
`whenTrue.type || whenFalse.type`, and the `null` literal HAS a type — so `x == null ? null : <number>`
types the whole expression as `null`, and `ExpressionContainer.register` throws

```
Expression 'Duration' on 'LoadMethodLogEntity' did not resolve to a translatable value:
its tail method is neither @quoted nor @resultType (a forgotten @quoted?).
```

which points at entirely the wrong thing. Writing the branches value-first is the workaround, and all the
`Duration` helpers now do. The fix is to prefer the non-null branch in `calculateType`.

### F3 — `since().total()` over two PostgreSQL `date` columns emits invalid SQL
The nominator emits `EXTRACT(EPOCH FROM (date - date))`, but `date - date` is an integer day count in
PostgreSQL, so it fails at runtime with `function pg_catalog.extract(unknown, integer) does not exist`.
SQL Server's `DATEDIFF` path is correct. Nothing hits it today — every log's duration spans two
`PlainDateTime` columns — so it is latent.

### F4 — no `[Unit]` equivalent for a registered expression
`QueryLogic.expressions.register` has no `unit` option, so none of the `Duration` columns can show
Signum's "ms" suffix. The unit survives only in the member name.

### F6 — `total(unit)` is a BOUNDARY COUNT on SQL Server, and the two providers disagree — **DONE**

> Done with F7 (same two functions). SQL Server now takes a FINER DATEDIFF part and divides, as Signum's
> `TrySqlDifference` does, through `CAST(DATEDIFF_BIG(part, start, end) AS float)` — `_BIG` because the
> finer part makes the `int` overflow reachable (verified: `DATEDIFF(millisecond, …)` over one month
> already throws), and the CAST because `… / 60` is INTEGER division otherwise. Singular unit names are
> accepted; the calendar units are refused with a message naming the unit and the difference.

`translateDurationMethod` emits `DATEDIFF(<unit>, start, end)` with the requested unit directly. On SQL
Server `DATEDIFF` counts *boundaries crossed*, not elapsed time: `01:59 → 02:01` is **1** hour, where
`.total({ unit: "hours" })` must be **0.0333**. Signum never asks `DATEDIFF` for the coarse unit for
exactly this reason — `TrySqlDifference` always takes a FINER one and divides:

```
day → DATEDIFF(minute)/1440   hour → DATEDIFF(minute)/60   minute → DATEDIFF(second)/60
second → DATEDIFF(millisecond)/1000   millisecond → DATEDIFF(millisecond)
```

The PostgreSQL branch is already correct (it divides `EXTRACT(EPOCH …)`), so **the same expression
returns different numbers on the two providers today** — and the six `Duration` columns just ported all
run through it. Milliseconds, the unit they all use, is the one case that happens to agree.

Three more in the same function:
- **`DIFF_UNITS` is keyed by PLURAL names only** (`minutes`, `milliseconds`, …), but Temporal accepts the
  singular too, and `durationUnit` returns `undefined` for one — which silently means "not translatable".
  `CaseActivityEntity.durationRealTime()` (`altea-workflow/data/CaseActivity.ts:112`) is `@quoted` and
  written `…until(Clock.now, { largestUnit: "minute" }).total({ unit: "minute" })`, so it cannot lower for
  BOTH this reason and F7's missing `until`. It is not registered as an expression today, so nothing has
  hit it — but it is declared translatable and is one filter away from failing.
- `DIFF_UNITS` accepts `years` / `months` / `weeks`, which Signum's switch rejects outright. PostgreSQL
  divides EPOCH by an *average* year (31557600s) while SQL Server counts calendar-year boundaries, so
  `total({ unit: "years" })` disagrees by design, not by rounding. Nothing in the workspace asks for a
  coarse unit in a translatable position, so rejecting them (Signum's behaviour) is safe today.
- `DATEDIFF(millisecond, …)` overflows `int` at ~24.8 days. Signum uses `DATEDIFF_BIG` where the
  connector supports it.

A `preSaving` hook or any other in-memory caller may keep using singular units and `until` freely —
those run in JS, where Temporal accepts both. The rule only binds inside a `@quoted` body.

### F7 — `until()` is not translatable, and duration COMPONENTS are not the same as totals — **the `until()` half is DONE**

> `until` now has a result type (`dateTime.until` / `date.until`) and lowers as `since` with the operands
> swapped, so `CaseActivityEntity.durationRealTime()` lowers. A `{ largestUnit }` option is accepted and
> ignored (it cannot change what `total()` answers); a rounding option is refused rather than dropped.
> **The component accessors below are still open, and still should not be added casually.**

Only `since()` produces the `__timespan__` marker (`dbExpressionNominator.ts:679`); `until()`, its exact
mirror, is unhandled and fails at query time. That one is trivial and worth doing.

**Component accessors (`.years`, `.days`, `.hours`) are a different feature and should not be added
casually.** `x.since(y)` / `x.until(y)` on a `PlainDateTime` returns a duration balanced only up to
**days**; `.years` is 0 unless the call passes `{ largestUnit: "years" }`, and calendar units additionally
need a `relativeTo`. So `start.until(end).years` would silently answer 0 for a correct-looking expression
— worse than refusing it. Signum has no counterpart either: its `TimeSpan.Hours` / `.Minutes` /
`.Seconds` / `.Milliseconds` lower to `DATEPART` over a stored **time column**, not over a date
difference, and `TimeSpan` has no years or months at all. If components are wanted, they belong on a
stored `PlainTime` column, mirroring `DATEPART`, and `largestUnit` must be honoured or rejected.

### F5 — `Connector.replaceException` misses a deferred constraint
It only sees statements that pass through `withLogging`; a `DEFERRABLE INITIALLY DEFERRED` constraint is
checked at COMMIT, which goes straight to the `ConnectionHandle`. altea generates none today.

---

## A. Display names that are never localized

### A1 — Query-token enums render raw English
`AggregateFunction`, `CollectionAnyAllType`, `CollectionElementType`, `CollectionToArrayType`
(`altea/data/dynamicQuery/tokens/*.ts`) are string enums whose members are spliced straight into
`toString()` / `niceName()`. `aggregateToken.ts` says so: *"altea's enum members ARE their display strings
(bare literals), so no niceToString lookup."* A German user sees "Sum of Unit price", "Any of Details",
"SeparatedByComma of Details" in the token picker and in every column header.

Signum localizes all four, plus the qualifier words the aggregate label is built from (`Distinct`,
`of`, `Not Null` — `AggregateToken.GetNiceDistinct` / `GetNiceOperation` / `GetNiceValue`).

**Done when** the four enums are `registerEnum`'d, `toString()`/`niceName()` resolve through
`Enum.niceName`, the qualifiers come from a message container, and the Signum translations are back in
`Altea.<culture>.xml`. `key` / `fullKey` are separate members of `QueryToken`, so nothing keyed changes —
verify that explicitly.

### A2 — `BooleanEnum`
`EnumLine.tsx:339` is `{ label: "False", value: false }, // TODO(port): BooleanEnum localized labels`.
Port Signum's `BooleanEnum { False, True }` and use it for the boolean dropdown.

### A3 — react-widgets messages
`react-widgets-up` is a real dependency and `ReactWidgetsLocalizer.tsx` supplies only the date and number
localizers. `<Localization>` also takes `messages`, which altea never passes, so combo boxes, multiselects
and date pickers render English ("Select", "Move back", "There are no items in this list", "Create option")
in every culture. Signum ships `ReactWidgetsMessage` (16 members) and `CalendarMessage.Today` for exactly
this. Port both and pass them at every `<Localization>` site.

### A4 — `CollectionMessage.No0Found` / `MoreThanOne0Found`
Signum.Utilities raises these from `SingleEx` / `SingleOrDefaultEx`. altea's single-element accessors throw
unlocalized English. Port the two messages and use them.

### A5 — `StringCase` + `StringCaseValidator` — **DONE**
Signum's `[StringCaseValidator(StringCase.Uppercase)]`. Both the enum and `@stringCaseValidator` live in
`data/validators.ts`, which is where Signum declares them too (both in ValidationAttributes.cs, unlike
DateTimePrecision, which Signum keeps in a utilities file) — with a hand-written `registerEnum`, since no
entity field is of that type.

Unlike its sibling B4 this really is ONLY a check: it REPORTS a value in the wrong case and never rewrites
it (Signum's `OverrideError` returns a message and nothing more), nothing is denormalised onto `FieldInfo`
because no reader is out of reach of `fi.validators`, and it does not touch the column — a string's size
comes from `StringLengthValidator` (B6), so no DDL changed.

One DIVERGENCE: Signum's `Reflector.GetFormatString` also derives a format string from this validator,
`"U"` or `"L"`, and nothing in Signum ever reads either specifier back (no formatter on either tier
handles them), so altea derives no format here.

altea-dynamic now uses the real thing: `DynamicValidator`'s `StringCase` member is typed `StringCaseKeys`,
the editor offers the enum's own member names, and `DynamicTypeLogic.getValidatorDecorator` emits
`stringCaseValidator(StringCase.Uppercase)` — resolving the stored name CASE-INSENSITIVELY, because
Signum's own editor writes `"UpperCase"` / `"LowerCase"` against a C# enum spelled `Uppercase` /
`Lowercase` and System.Text.Json reads that back regardless of case.

### A6 — `PermissionSymbol` lives in `altea-auth`, not core
Signum declares it in the core assembly; altea in `altea-auth/data/Rules.ts`. Consequences: a module that
wants to declare a permission must depend on `@altea/altea-auth`, and the German description Signum ships
lands in the core translation file where the sync deletes it.

`UserHolder` is already in core (`altea/server/userHolder.ts`) for precisely the "don't make every module
depend on auth" reason, so the precedent exists. **Evaluate** moving `PermissionSymbol` (and only the
symbol — the rule entities and the logic stay in `altea-auth`) to core; if it moves, the translation
follows it. Spanish has no Signum text for it (Spanish is Signum's default culture), so
`Altea.Auth.es.xml` needs a fresh one either way.

### A7 — `HtmlEditorMessage` has nowhere to land
`altea-html-editor/data/HtmlEditor.ts` registers the container correctly, but the package has no
`translations/` directory, no line in `eastwind/terminal/translationFiles.txt`, and nothing on the server
graph imports it — so it is not even a localizable package. Signum keeps these 11 strings in its CORE
file, so the routing line is the unusual one: core → `altea-html-editor`. Needs a wiring decision for the
server import as well (the package's only server module, `HtmlToPlainText.ts`, is not started).

---

## B. Missing engine behaviour

### B1 — Foreign-key / unique-key violations are not translated
This is why `EngineMessage.ThereAreRecordsIn0PointingToThisTableByColumn1` had no caller: altea has **no
equivalent of Signum's `ForeignKeyException` / `UniqueKeyException`** (`Signum/Engine/Exceptions.cs`), which
parse the driver's message, map the table and column back to the entity type and property, and re-raise as

- "There are {0} that refer to this entity by {1}"  (delete blocked by an FK)
- "The column {0} of the {1} does not refer to a valid {2}"  (insert/update with a dangling FK)
- "There is already a {0} with the same {1}"  (unique index)

Today the raw driver error surfaces: `Key (state_id)=(0) is not present in table "alert_state"`, PG error
`23503`, constraint `fk_alert_state_id`. Port the translation layer for both PostgreSQL and SQL Server.
The four messages are already in Signum's XML.

### B2 — `OperationLogEntity.Duration`
`operationLog.ts:25`: *"no ExpressionField-over-Temporal-difference support yet. TODO(port) if a duration
column is wanted."* `SessionLogEntity` and `RestLogEntity` already register a `durationSeconds()` expression
(`QueryLogic.expressions.register(..., { key: "Duration", … })`), so the pattern exists — this one is just
missing. `ScheduledTaskLogEntity`, `ProcessEntity`, `LoadMethodLogEntity` and `ViewLogEntity` lost the same
`Duration` translation and should be checked in the same pass.

### B3 — `DeleteLogs` machinery
`exceptionLogic.ts:13` lists "the log-cleanup/DeleteLogs machinery, per-environment overrides" as not
ported. Signum's `DeleteLogParametersEmbedded` (ChunkSize / DeleteLogs / MaxChunks / PauseTime) and
`DeleteLogsTypeOverridesEmbedded` (DeleteLogsOlderThan / DeleteLogsWithExceptionsOlderThan / Type) are the
scheduled task that keeps log tables from growing without bound. Port both plus the task.

### B4 — `DateTimePrecision` — **DONE**
Signum's `DateTimePrecision { Days, Hours, Minutes, Seconds, Milliseconds }` and its
`[DateTimePrecisionValidator]`. The enum and `getPrecision` live in `data/globals/dateTimeExtensions.ts`,
where Signum keeps them too (Signum.Utilities/DateTimeExtensions.cs), with a hand-written `registerEnum`
because no entity field is of that type; `@dateTimePrecisionValidator` is in `data/validators.ts`.

It is not only a check. Signum's attribute feeds three more readers, and all three are ported, reached
through `FieldInfo.dateTimePrecision` rather than by walking the validator list: the display FORMAT
(`Reflector.GetFormatString` → `defaultFormat`, with two altea-only specifiers in `toDateFormatOptions`
for the cases .NET spells as culture patterns), the date SUB-TOKENS a query offers (`DateTimeProperties`
trimmed to the precision), and `IsGroupable` (a `Days` DateTime groups like a date).

What it does NOT do, despite the shape inviting it, is size the column: Signum's
`SchemaSettings.GetSqlPrecision` has that validator lookup commented out, and `GetSizePrecisionScale`
renders a precision only for a decimal. So `StringLengthValidator`→size (B6) and `DecimalsValidator`→scale
have no third sibling, and no DDL changed.

Restored where the port had dropped it: `SessionLogEntity.sessionStart` / `.sessionEnd` (Seconds),
`SMSMessageEntity.sendDate` (Seconds), and `ProcessEntity.plannedDate` / `.cancelationDate` /
`.queuedDate` / `.executionStart` / `.executionEnd` (Milliseconds) — the five Signum declares.

### B6 — `StringLengthValidator` does not size its column
Signum's `SchemaSettings.GetSqlSize` derives a string column's size from the property's validator:

```csharp
if (att != null && att.HasSize) return att.Size;                     // explicit [DbType(Size=…)] wins
if (route != null && route.Type == typeof(string)) {
    var sla = ValidatorAttribute<StringLengthValidatorAttribute>(route);
    if (sla != null) return sla.Max == -1 ? int.MaxValue : sla.Max;   // the implicit one
}
return defaultSize…TryGetS(dbType…);                                  // per-provider default
```

altea has only the explicit half: `SchemaBuilder` reads `fi.columnOptions?.size` (set by `@column({size})`)
and nothing else, so `@stringLengthValidator({ max: 200 })` sizes nothing and the column renders unbounded
— `nvarchar(MAX)` on SQL Server, bare `varchar` on PostgreSQL (`sqlBuilder.ts:292-302`).

That is not only wasted storage. **`nvarchar(MAX)` cannot be an index key column**, so
`pnpm --filter @altea/altea gen:sqlserver` fails outright:

```
Column 'TableName' in table 'basics.Type' is of a type that is invalid for use as a key column in an index.
```

`TypeEntity.tableName` / `cleanName` are `@uniqueIndex`; Signum declares both
`[StringLengthValidator(Max = 200), UniqueIndex]`. PostgreSQL does not complain, which is why the whole
SQL Server test environment has been ungenerable without anyone noticing.

**FULL PARITY is wanted**, so the third fallback comes too — Signum's per-provider default tables
(`SchemaSettings.cs:82-97`), which altea has no equivalent of at all:

| SQL Server | | PostgreSQL | |
|---|---|---|---|
| `NVarChar` | 200 | `Varchar` | 200 |
| `VarChar` | 200 | `Varbit` | 200 |
| `VarBinary` | `int.MaxValue` | `Char` | 1 |
| `Binary` | 8000 | | |
| `Char` / `NChar` | 1 | | |

with the `bytea` short-circuit at the top of `GetSqlSize` (PostgreSQL `bytea` takes no size at all).

**The precedent to mirror is already in the file.** `schemaBuilder.ts:1102-1103` ports
`GetSqlPrecision` / `GetSqlScale` exactly this way — explicit `@column` option, then a typed default:

```ts
const precision = fi.columnOptions?.precision ?? (isDecimal ? 18 : undefined);
const scale = fi.columnOptions?.scale ?? (isDecimal ? fi.decimalPlaces ?? 2 : undefined);
const column = new ValueColumn(name, dbType, nullable, fi.columnOptions?.size, precision, scale);
```

The `size` argument is the one slot with no such derivation. It wants a `getSqlSize` beside them.

**Done when** the validator sizes the column with Signum's precedence, the per-provider defaults are in,
and `gen:sqlserver` completes.

**This is a schema-wide change** — it re-sizes every string column in the workspace, not just the
validated ones. So: regenerate both test databases, and inspect a REAL sync script against an existing
database rather than trusting the generator, because `gen:*` executes `schema.generationScript()` inline
and never writes a file (the file-producing path is the terminal's `sync`, via `openSqlFile.ts`). An
existing PostgreSQL database will need `ALTER COLUMN … TYPE varchar(n)` for a great many columns, and a
column whose DATA is longer than its new size will fail that ALTER — which is exactly the kind of thing
the script is meant to be read for before it runs.

### B5 — `RoundingType`
Signum's `RoundingType { Floor, Ceil, Round, RoundMiddle }`, used to bucket numbers into histogram steps.
Port the functionality (it is what a chart's "step" parameter needs), not just the enum.

---

## C. Missing query tokens

### C1 — Date tokens
altea declares 11 of Signum's 34 `QueryTokenDateMessage` members. Missing and wanted: `DayOfWeek`,
`DayOfYear`, `Quarter`, `WeekNumber`, `TotalDays` / `TotalHours` / `TotalMinutes` / `TotalSeconds` /
`TotalMilliseconds`, `Every0Hours` / `Every0Minutes` / `Every0Seconds` / `Every0Milliseconds`,
`UtcDateTime`, `DateTimePart`, plus the plain `Day` / `Hour` / `Minute` / `Second` / `Month` /
`Millisecond` parts. Each needs a token factory, a SQL lowering per provider, and its translation.

### C2 — Other tokens
Port `MatchRank` / `MatchRankFor0` / `MatchSnippet` / `SnippetOf0` (full-text search ranking), `Nested`,
`Step0` and `Modulo0` / `_0Mod1`.

**Deferred, do not port:** `RowId` and `RowOrder` (altea has no MList — a collection is a `@part` row with
its own entity identity) and `PartitionId` (no partitioning).

---

## D. Missing validators and messages

### D1 — `ValidationMessage`
altea declares 25 members against Signum's 91, because it has 25 validators. Implement the missing
validators as Signum has them, and bring each one's translation with it. Four altea names have no Signum
twin and need text of their own — `_0HasToBe12`, `_0MustHaveAtLeast1Characters`,
`_0MustHaveAtMost1Characters`, `BeA01` — but Signum's `HaveMinimum0Characters`, `HaveMaximum0Characters`
and `BeA0_G` say the same thing and can be adapted rather than invented.

### D2 — `OperationMessage`
Port `InUserInterface`, `Logs` and `Operation01IsNotAuthorized`.

### D3 — `SearchMessage`
altea declares 82 of 114. Port the missing FUNCTIONALITY, not the strings alone: `SmartSearchDescription`,
`GroupPrefix`, `FilterGroupInvalidMixedOperations`, and the pair
`NoResultsFoundBecauseYouAreNotAllowedToExplore0WithoutFilteringBy1First` /
`NoResultsFoundBecauseTheRule0DoesNotAllowedToExplore1WithoutFilteringFirst` (the query-auth rule that
refuses an unfiltered search).

### D4 — `CultureInfoEntity.IsNeutral`
Keep it: the culture dropdown filters on it. altea derives `nativeName` / `englishName` from
`Intl.DisplayNames`; `isNeutral` is derivable the same way (a neutral culture is a language tag with no
region subtag).

---

## E. Deliberately NOT ported — no action

`DateTimeMessage` (altea uses `Intl.RelativeTimeFormat`, which the browser localizes) ·
`ConsoleMessage` (developer terminal, English by design) · `SynchronizerMessage` (no script banner) ·
`DisabledMixin` / `DisabledMessage` / `DisableOperation` · `FontSizeMessage` ·
`ContainerToggleMessage` / `ContainerTokenKey` · `NumberUnitsMessage` · `LiteMessage` ·
`VoidEnumMessage` · `PaginationMessage.All` (duplicate of `PaginationMode.All`) ·
`EmbeddedEntity` / `ModelEntity` / `ModifiableEntity` / `IEntity` (abstract bases nothing names;
`ModifiableEntity` IS altea's `BaseEntity`) · `EmailOwnerData` (a plain interface here) ·
`TypeEntity.FullClassName` (altea has `package` + `className`) ·
`FilterOperation.GreaterThanOrEqualTo` / `LessThanOrEqualTo` (a converter artefact: `ComparisonType` is
merged into `FilterOperation`, and altea's shorter spellings are present and translated) ·
`ExceptionOrigin.Backend_DotNet` / `Frontend_React` (renamed to `Backend` / `Frontend`).
