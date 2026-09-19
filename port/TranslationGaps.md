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

### F8 — a `Decimal` COLUMN had no runtime type — **FIXED**
`QueryBinder.valueType` (the FieldInfo → RuntimeType map the binder stamps on a value column) had cases for
String / Number / Boolean / the three temporals and **no case for `Decimal`**, so a decimal column bound as
`LiteralType.null`. Two consequences, both silent:

- the INSTANCE decimal operators could not lower (`a.unitPrice.times(2)` → "The method 'times' cannot be
  translated to SQL"). Only the STATIC form worked, because `Decimal.mul(…)` types ITSELF through
  `__resultType` — which is why every `@quoted` body in the workspace is written that way and nobody hit it;
- the column materialised RAW, so on PostgreSQL a `Decimal` field came back as the STRING the driver hands
  over for `numeric`. `translatorBuilder.visitColumn` has a `LiteralType.decimal` branch for exactly this
  ("Postgres hands it back as a string (exact)") and it could only ever fire for a COMPUTED decimal.

`baseTypeOfFieldInfo` — the sibling mapping in `server/linq/expressions.ts` that altea-cache reads — has
always had the case, so the two had simply drifted. Fixed by adding it; the whole framework suite is green.

### F9 — the in-memory query interpreter could not call a captured FUNCTION — **FIXED**
`evalExpr` (`server/dynamicQuery/dEnumerable.ts`) handled `CallExpression` only when the callee was a
`PropertyExpression` (a method on a receiver). A call on a captured function — `Number(x)`, the binder's own
float cast, plus `toInt` / `inSql` / any branded SQL helper — fell through to `throw new Error("evalExpr:
unsupported expression CallExpression")`. In memory the captured function IS the implementation, so applying
it is both the simplest and the right answer.

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

### A4 — `CollectionMessage.No0Found` / `MoreThanOne0Found` — **DONE**
Signum.Utilities raises these from `SingleEx` / `SingleOrDefaultEx`; altea's `Array.prototype.single` /
`singleOrNull` (`data/globals/arrayExtensions.ts`) now raise them in place of hand-concatenated English.

The `{0}` is Signum's `elementName` argument, which is exactly what altea's `errorContext` parameter
already carried — so no signature changed. The fallback when a caller passes none stays the generic word
`"element"`, unlocalized: Signum's own fallback is `typeof(T).TypeName()`, equally unlocalized, and a
generic's type argument is erased at runtime here anyway.

One DIVERGENCE: Signum localizes only on its `forEndUser: true` overload and keeps "Sequence contains no
{0}" for the others. altea's accessors have no such flag — there is one message per case and it is the
localized one.

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

### A8 — `ComparisonType` was never registered — **DONE**
The sibling of A5: `ComparisonType` (`data/validators.ts`) had no `registerEnum`, so `Enum.niceName` had
no key and fell back to the English identifier — inside `ValidationMessage._0HasToBe12` and
`HaveANumberOfElements01`, which a user reads, in every culture. Registered, `comparisonName` now goes
through `Enum.niceName`, and Signum's German/Spanish are back in `Altea.<culture>.xml`. FirstLower for
both callers, where Signum's own `CountIsValidator` uses `FirstLower` and `NumberIsValidator` `ToLower`.

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

### B3 — `DeleteLogs` machinery — **DONE**
Signum's `DeleteLogParametersEmbedded` (ChunkSize / DeleteLogs / MaxChunks / PauseTime) and
`DeleteLogsTypeOverridesEmbedded` (DeleteLogsOlderThan / DeleteLogsWithExceptionsOlderThan / Type) are in
`altea/data/deleteLogs.ts`, where Signum keeps them (Basics/Exception.cs); the runner and the registry are
`ExceptionLogic` (`registerDeleteLogs` / `deleteLogsAndExceptions` / `deleteChunksLog`).

**The strategy, which is the part worth reading.** A run is `Transaction.none` — each chunk has to COMMIT,
or chunking buys nothing. Every registered handler trims its own table through `deleteChunksLog`, which is
`Query.executeDeleteChunks(chunkSize, maxChunks, pauseTime, signal)`: `ORDER BY id TOP n` deleted
repeatedly, so each statement takes a short lock, with `pauseTime` handing the table back to the
application between bites and `maxChunks` bounding ONE run — a backlog drains over several runs rather
than one very long one. Then the exceptions go last: `referenced` is blanked and recomputed from every
column in the schema that is a foreign key to the exception table, so an exception a handler could not
reach (it ran out of chunks) survives this run, and only the unreferenced ones older than the cut-off go.

Per-type overrides ARE the policy: a type with no row is never swept at all. Each type gets two cut-offs —
`deleteLogsOlderThan` for ordinary rows and the SHORTER `deleteLogsWithExceptionsOlderThan` for rows that
recorded a failure (validated to be the shorter one) — and both are midnight N days back, or the start of
this hour for 0, so the window does not drift between chunks. `altea/test/data/deleteLogParameters.test.ts`
pins that arithmetic.

`DeleteLogParametersEmbedded` becomes a table only through an owner. Core has none: the owner is
`@altea/altea-scheduler`'s `DeleteLogsTaskEntity` (an `ITaskEntity`), started opt-in by
`DeleteLogsTaskLogic.start(sb)` — Signum leaves the owner to the application the same way.

Registered handlers: `OperationLogEntity` + `SystemEventLogEntity` (core), `SessionLogEntity`
(altea-auth), `RestLogEntity` (altea-rest), `ScheduledTaskLogEntity` + `SchedulerTaskExceptionLineEntity`
(altea-scheduler), `ProcessEntity` + `ProcessExceptionLineEntity` (altea-processes), `ViewLogEntity`
(altea-view-log), `LoadMethodLogEntity` (altea-migrations). Signum's remaining handlers —
`EmailMessageEntity`, the SMS pair and `WorkflowEventTaskConditionResult` — are still unported, as are
`Connector.CommandTimeoutScope` (altea has no per-command timeout scope) and `ExecuteChunksLog` (Signum's
chunked UPDATE twin, which has no caller in the framework).

`exceptionLogic.ts`'s header keeps "per-environment overrides" as the one piece of Signum's ExceptionLogic
still missing.

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

### B5 — `RoundingType` — **DONE** (with C2's `Step0`; they are one feature)

`RoundingType { Floor, Ceil, Round, RoundMiddle }` lives in `data/dynamicQuery/tokens/stepToken.ts`, where
Signum declares it too (DecimalSpecialTokens.cs, beside the tokens that consume it) — a STRING enum with a
hand-written `registerEnum`, like its four siblings in that folder: the member name IS the token key and is
stored inside a user asset's token string (`UnitPrice.Step1.x2_5.RoundMiddle`), so it may never be an ordinal.

The FUNCTIONALITY is `roundToStep` (`server/dynamicQuery/tokenExpressions.ts`), a port of
`RoundingExpressionGenerator.RoundExpression` — subtract half a step for `RoundMiddle`, divide, snap, multiply
back, add the half back. The three levels of Signum's token chain all call it and all build from the ORIGINAL
numeric token, never from the level above.

Two things worth knowing:

- **`Number(x)` first is not cosmetic.** Signum's `Expression.Convert(result, typeof(double))` is what stops
  `int / int` being INTEGER division — on BOTH providers. Without it `ceil(orderId / 1000) * 1000` silently
  answers the FLOOR bucket on every integer column. `Number(x)` is altea's spelling (the binder lowers it to
  `CAST(… AS float)` / `CAST(… AS double precision)`).
- **A `Decimal` token takes the decimal.js method chain instead** (`x.dividedBy(s).ceil().times(s)`), which
  lowers to the same SQL through `decimalCall` but stays exact, because `ceil(x / 0.1)` in binary floating
  point does not. A `Number` token whose `subTypeName` is `decimal` (altea's branded alias) is a plain JS
  number at runtime and takes the float path.

DIVERGENCE, shared with Signum and unavoidable: JS `Math.round` and SQL `ROUND` round a half AWAY from zero,
.NET's `Math.Round` rounds it to EVEN — so `Round` over -2.5 answers -3 here and -2 in Signum's in-memory path.

---

## C. Missing query tokens

### C1 — Date tokens — **DONE**

> The backlog read as "port the missing tokens", and that was the smaller half. Most of them EXISTED:
> `QueryToken.dateTimeProperties` / `dateOnlyProperties` built them with `capitalize(memberName)` as the
> caption, so `Year` / `Quarter` / `Month` / `DayOfYear` / `Day` / `DayOfWeek` / `Hour` / `Minute` /
> `Second` / `Millisecond` displayed an English literal in every culture — and, because no
> `QueryTokenDateMessage` member existed for them, the sync had nowhere to hang Signum's German and
> Spanish and deleted it. Every caption now routes through a message member, and `DateToken` with them.
>
> Genuinely added: **`WeekNumber`** (on a PlainDateTime and a PlainDate), the four **`Every0…`** stepped
> `DatePartStartToken`s with Signum's own bucket sizes, and the whole **`TimeSpanProperties`** family on
> a `Duration` — the components `Days` / `Hours` / `Minutes` / `Seconds` / `Milliseconds` and the
> measures `TotalDays` … `TotalMilliseconds`.
>
> Three DIVERGENCES from Signum, each because Signum's own two providers disagree:
>  - `WeekNumber` is ISO-8601 everywhere (SQL Server `iso_week`). Signum answers three different numbers
>    for it: culture rules in memory, `DATEPART(week)` on SQL Server, ISO `EXTRACT(week)` on Postgres.
>  - the `Every0…` steps are `date_trunc` minus the part's remainder. Signum's SQL Server form counts the
>    part from year 0 in an `int` (a millisecond step overflows it) and its Postgres branch drops the step
>    entirely, answering the UNSTEPPED truncation.
>  - `Total…` over a STORED Duration column works. A Duration column is a `time` on both providers, i.e.
>    an elapsed time whose other operand is MIDNIGHT, and naming midnight is what makes the token family
>    reachable at all. Signum's `TrySqlDifference` looks for a subtraction, finds none and returns null,
>    so its own `TimeSpan.TotalMinutes` over a stored column does not translate.
>
> NOT ported, and why: **`UtcDateTime` / `DateTimePart`** are `DateTimeOffset` members, and altea has no
> DateTimeOffset query type — `Instant` / `ZonedDateTime` map to `datetimeoffset` / `timestamptz` in the
> schema but `tryGetFilterType` does not classify them and the LINQ layer types them as a `ClassType`, so
> there is no token to hang the two members off. **`TimeOfDay`** and Signum's `TimeOnlyProperties` are
> blocked on the same kind of hole one type down: `fieldLiteralType` has no `PlainTime` case, so a
> PlainTime column is a `ClassType` too and none of its parts lower. **`HourStart` / `MinuteStart` /
> `SecondStart` / `Every0…` on a Duration** are left out deliberately: bucketing exists on a date because
> `Month` alone loses the year, and inside one duration `Hours` already IS the bucket.
>
> Found on the way, NOT fixed: `QueryTokenHelpMessage` (the token help text) is still stubbed.

### C2 — Other tokens — **DONE except `Nested`**

> `Step0` / `_0Steps1` (with B5's RoundingType), `Modulo0` / `_0Mod1`, `MatchRank` / `MatchRankFor0`,
> `MatchSnippet` / `SnippetOf0` and — found in the same line of code — `Length` are in. **`Nested` is NOT,
> and the reason is that it is not a token at all; see the bottom of this item.**

**`Step0`** — the `Step → xMultiplier → Rounding` chain, `data/dynamicQuery/tokens/stepToken.ts`. Signum's
three levels are a UI affordance, not three ideas: `Step 1000` offers `x1 … x8` so 1500 and 2500 are
reachable without listing every size, and each multiplier offers the four roundings; every level is a
complete groupable token on its own (`Step1000` alone means `x1`, `Ceil`). The arithmetic is B5 above.
`subTokensBase` now splits the numeric branch the way Signum splits it: a WHOLE number gets steps from 1 up
plus the modulo tokens, a FRACTIONAL one gets sub-unit steps down to its own decimals and no modulo
(`x mod 100` says nothing about a fractional value). The decimals come from the token's own display format
(Signum's `Reflector.NumDecimals`), which is where `@decimalsValidator(4)` already reaches this layer.

**`Modulo0` / `_0Mod1` / `Length`** were the C1 bug one more time: `ModuloToken` built `"Modulo " + divisor`
and `stringTokens` passed the literal `"Length"`, so both showed English in every culture and the sync had
no member to hang Signum's German and Spanish on. All three are messages now.

**`MatchRank` — PostgreSQL only, and SQL Server THROWS.** This is the one place the two providers could not
be made to agree, so here is precisely what was left out and why.

Signum has TWO rank tokens because its two providers reach a rank from different places. On Postgres
(`PgTsRankToken`) the rank is the scalar `ts_rank(tsvector, tsquery)` and hangs off a tsvector COLUMN token.
On SQL Server (`FullTextRankToken`) there is no scalar rank function at all: `CONTAINS` / `FREETEXT` are
predicates and nothing else, and the score lives in the `RANK` column of the `CONTAINSTABLE` /
`FREETEXTTABLE` table-valued function — so `DQueryable.SelectWithFullTextTable` rewrites the whole query
into a JOIN against that function, keyed on the row id, and re-seats every existing replacement onto the
joined tuple.

altea has ONE token, on the indexed string property (which is where altea already puts the full-text FILTER
operations — `FindOptions.getFilterOperations` keys off `fieldInfo.hasFullTextIndex`), and only the Postgres
half is implemented: `entity.getTsVectorColumn().rank(<the tsquery the filters asked for>)`, with the
tsquery rebuilt from the query's own `TsQuery*` filters on the same token and combined with each filter
group's own operator (`&&` / `||`), exactly as `PgTsRankToken.GetCombinedTsQuery` does. No such filter ⇒ a
constant 0, Signum's own fallback.

On SQL Server the token is still OFFERED — sub-token generation is provider-agnostic and runs on the client,
which has no connector — and `buildExpressionInternal` throws a message naming `CONTAINSTABLE`. The
alternative, answering 0 or borrowing the Postgres shape, would be a silently wrong relevance ordering.
**What a SQL Server implementation needs is the table-valued-function JOIN**, which altea's dynamic query
does not build at all (a full-text filter lowers to an inline predicate); that is a DQueryable change of the
same size as the nested-query machinery below, not a token.

**`MatchSnippet` — both providers, and it is not a database expression on either side.** Signum selects the
text column and calls `Highlighter.FindSnippet` FROM THE LINQ PROJECTOR, i.e. in the application process.
altea does the same thing one stage later: the token's expression IS its parent's (so the text is what the
SELECT fetches) and `applySnippets` (`server/dynamicQuery/snippet.ts`) rewrites the column's values in
`AutoDynamicQueryCore.executeQueryAsync`. It has to be later because altea's projector is COMPILED TO
JAVASCRIPT SOURCE from the expression tree and has no node for "call this closure per row"; doing it per
ResultTable also means it can see the request's FILTERS, which is where the words come from
(`Filter.getKeywords`, a port of Signum's two `GetKeywords` overrides — each full-text query language split
by its own operator vocabulary).

Consequences of that placement, both deliberate: a `ManualDynamicQueryCore` gets no snippet (it builds its
own ResultTable — Signum's manual queries do not get one either, for the same reason), and ORDERING by a
snippet orders by the raw text. Signum rewrites an order on a snippet into an order on the RANK
(`Order.cs:28`); that rewrite is worth having once SQL Server has a rank, since on Postgres alone it would
succeed or throw depending on the provider.

Two small DIVERGENCES from Signum, both deliberate: the rank token is typed a nullable FRACTIONAL number
(Signum types both of its rank tokens `int?`, which is simply wrong for `ts_rank` and would make the client
render and filter a 0…1 score as a whole number); and `StringSnippetToken.niceName()` uses `SnippetOf0`
("Snippet for {0}"), the message Signum declares for exactly this and never calls — its own `NiceName`
passes the parent's name to `MatchSnippet`, which has no placeholder, so the argument is dropped and the
long form reads identically to the short one.

**`Distance` / `SmartSearch` — BOTH providers, and the embedding is a CORE SEAM.** The vector half of the
same story: `FilterOperation.SmartSearch` is prose the user types against a `vector(N)` column, turned into
an embedding and used to RANK rows — the client half (`FilterType.Vector`, the `VectorSmartSearch` value
editor, `SmartSearchDescription`) was already here and could never fire, because nothing server-side
produced `FilterType.Vector`. Four pieces landed together:

- `QueryUtils.tryGetFilterType` now answers `"Vector"` for the `Vector` class (`isVectorType`, by class
  identity — a `Vector` field gets a `type: () => Vector` thunk and NO `typeName`, so the switch could
  never have matched a string).
- `VectorDistanceToken` (`data/dynamicQuery/tokens/vectorTokens.ts`). Signum reaches it through a
  synthetic `VectorColumnToken` minted server-side from `Schema.Current`'s `VectorTableIndex` entries;
  altea's token tree is isomorphic and has no Schema, and the column already HAS a token, so `Distance`
  hangs off the vector property's own `EntityPropertyToken` — the same move `MatchRank` makes above.
  What the index was needed for is the distance METRIC, so `@vectorIndex` now stamps its per-dialect
  options onto the covered `FieldInfo` (`vectorIndex`, beside `hasFullTextIndex`); a vector column with no
  index offers no `Distance`, exactly as Signum offers no `VectorColumnToken` for one.
- The filter contributes **no predicate** (Signum's `Expression.Constant(true)`): the prose is the query
  VECTOR, not a condition. `DQueryable.where` now DROPS a constant-true body instead of ANDing it in —
  a lone one reached SQL as a bare parameter, and `WHERE @p1` is not valid T-SQL.
- The embedding seam, `server/dynamicQuery/smartSearch.ts`, filled by @altea/altea-agent's
  `LanguageModelLogic.start`. With none registered it **throws**: a permission check with no policy can
  honestly allow, but a smart search with no model has no answer at all, and both alternatives (drop the
  filter, or rank against a zero vector) hand back a plausible ordering that is wrong.

Two divergences. The seam is **async**, so it is resolved by a PASS over the request's filters in
`DynamicQueryContainer.executeQueryAsync` (where the SystemTime scope is opened) rather than lazily inside
`BuildExpressionInternal` as Signum does — Node cannot block on Signum's `.ResultSafe()`, and the pass also
means a missing implementation is reported at the query instead of silently ignored. And **both providers
build the distance**, where Signum's `Filter.ToTableFilter` gates SmartSearch on `SqlServerConnector`: on
SQL Server it rewrites the query into a `VECTOR_SEARCH` table-valued-function JOIN that also keeps the 100
nearest rows. altea's vector substrate (`server/vectorSearch`, the QueryBinder's `bindPgVectorDistance` /
`bindSqlVectorDistance`, the `vector` / `VECTOR(n)` casts) covers both dialects already, so the inline
`cosine_distance(…)` / `VECTOR_DISTANCE('cosine', …)` shape is used on both and nothing is refused. **What
is NOT ported is that TVF join**, and with it SmartSearch's implicit top-100 narrowing on SQL Server — the
same missing machinery as the `CONTAINSTABLE` join above, and it should land with it. The one thing that
DOES throw is a `Hamming` / `Jaccard` index: pgvector measures those over a `bit` column, which altea does
not model, so the token names the gap rather than quietly measuring cosine.

**`Nested` — NOT PORTED. It is a whole feature, not a token.** `CollectionNestedToken` throws
"should have a replacement at this stage" in Signum too: the token is only a marker, and everything it means
lives in the query pipeline around it —

- `DQueryable.SelectWithNestedQueries` / `NestedQueryConstructor` / `GetCollectionExpression` (~200 lines):
  the selected tokens are grouped by their deepest nested ancestor into a TREE, and each node becomes its
  own sub-query (`collection.Where(itsOwnFilters).OrderBy(itsOwnOrders).Select(itsOwnTuple).ToList()`)
  projected into a slot of the parent tuple, with its own `BuildExpressionContext` carried on the
  `ExpressionBox` (`subQueryContext` — a field altea's ExpressionBox does not have).
- `ResultTable` becomes recursive: `DQueryable.ToResultTableSubQuery` builds a nested ResultTable per cell,
  so a `ResultColumn`'s value may be a whole table. altea's `ResultTable` is flat columns of scalars, and
  the wire DTO and the client's `SearchControl` cell renderer both assume that.
- `QueryRequest.ValidateNested`: a filter or an order on a nested token is refused unless the same nested
  token is also a COLUMN, because the sub-query it belongs to only exists if something selected it.

None of that is reachable from the token layer, and half of it is client work. It is its own port item —
the natural sibling of the `CONTAINSTABLE` join above — and should be written up as one rather than left as
a line in this list. Nothing in the workspace asks for it today: `SubTokensOptions.CanNested` exists,
`QueryToken.hasNested()` answers false for every token, and `Finder.tsx` already greys a nested token out.

**Deferred, do not port:** `RowId` and `RowOrder` (altea has no MList — a collection is a `@part` row with
its own entity identity) and `PartitionId` (no partitioning).

---

## D. Missing validators and messages

### D1 — `ValidationMessage` — **DONE**
The member count was a symptom of three things, and all three are closed.

> **Second pass — the container is now COMPLETE (46 members added).** The first pass declared the
> members altea itself had a caller for. That is the wrong test for a FRAMEWORK: an application built
> on altea reaches for `ValidationMessage.X` in its own `@validate` bodies and operation guards, and a
> member altea never declares is simply unavailable to it. All 91 of Signum's are declared now, with
> Signum's `[Description]` verbatim where it has one and the humanised name in altea's sentence case
> where it does not. Two deliberate departures, both of which the existing members made first: no
> trailing full stop, and a sentence FRAGMENT (one spliced into a help message) stays lowercase. Two of
> Signum's English typos are fixed in the TEXT while the member NAME keeps them, because the name is the
> key an application already references: `TheLenghtOf0HasToBeEqualTo1` and
> `WhenPressedTheFilterValueWillBeSplittedAndAllTheWordsHaveToBeFound` (SearchMessage).
>
> `isSetOnlyWhen` came with them, into `data/validators.ts` beside the container, because Signum declares
> it there (`ValidationAttributes.cs`) and three altea packages had written it out by hand.
> `test/data/validation/isSetOnlyWhen.test.ts` pins both directions and its definition of "not set".

**The abstract `RegexValidator` now exists**, as it does in Signum, and is what most of this item turned
out to be. `EMail` / `Telephone` / `URL` were hand-rolled with a duplicated null check, a duplicated
`test` and a hard-coded English message each; they are now a regex plus a `formatName`, and so are the
five that joined them (`AlphanumericOnly`, `MultipleTelephone`, `NumericText`, `Ip`, `Identifier`) plus
`FileName`, which Signum spells out separately for no reason — a regex of the characters it accepts says
the same thing. `FormatName` stays an English literal where Signum has one ("URL", "IP", "e-Mail"), and
reads from `ValidationMessage` for the three that name a concept (telephone, numeric, file name).

**Thirteen of the fourteen missing validators are in.** `IsAssignableTo` is NOT: it validates a
`TypeEntity` property, and resolving one to a constructor goes through the server's `Schema` (see
`propertyRouteLogic.resolveCtor`), so the validator could not run on the client — which every altea
validator does. Signum has no call site for it either.

**Help messages are localized.** `NotNull`, `StringLength` (all four branches, `BeAMultilineString`
included — the multiLine one had no branch at all), `NoRepeat` and the three regex ones returned hard-coded
English, which `altea-help`'s `HelpGenerator` compiles straight into the generated documentation. The four
altea-only members (`_0HasToBe12`, `_0MustHaveAtLeast1Characters`, `_0MustHaveAtMost1Characters`, `BeA01`)
have German and Spanish adapted from Signum's twins. `_0ShouldBeADateInTheFuture` / `BeInTheFuture` keep an
empty Spanish, which is what Signum has.

Five Signum regexes are unanchored, and `Regex.IsMatch` searches anywhere — `AlphanumericOnly` is
`[A-Za-z0-9]`, which passes "a#$%". Those are anchored here, and `IdentifierValidator.PascalAscii`
(`^[A-Z[_a-zA-Z0-9]*$` — the stray `[` makes it identical to the Ascii form) enforces the leading capital
its name promises. Each divergence is commented at the regex and pinned by a test.

Neither `NumberBetween` nor `TimePrecision` influences a column: `SchemaSettings` derives a size from
`StringLengthValidator` and a scale from `DecimalsValidator` and reads no other validator —
`GetSqlPrecision`'s lookup is commented out, which is the same finding the `DateTimePrecision` port made.
`TimePrecision` denormalises nothing onto the FieldInfo either: Signum derives a display format from it
(`FormatString_TimeSpan` / `FormatString_TimeOnly`), and those are custom .NET patterns that altea's
specifier vocabulary cannot express — `TimeLine` renders a fixed HH:MM:SS and reads no format.

> Found on the way, NOT fixed: `SMSMessageEntity.destinationNumber` (altea-sms) hand-rolls the
> multiple-telephone rule as a `@validate` with a message of its own, written when core had no such
> validator. `@multipleTelephoneValidator` now says it, and re-seating it would also make the field render
> as a phone in a search result — `FinderRules`' "Phone" cell now keys off both telephone validators, as
> Signum's `MemberInfo.IsPhone` does.

### D2 — `OperationMessage` — **DONE**
All three ported; none turned out to be a string without a caller.

`Operation01IsNotAuthorized` + `InUserInterface` are ONE message, not two: Signum's
`OperationLogic.OperationAllowedMessage` builds the refusal from the first and appends the second when the
refusal was the *button-state* check. altea threw a hand-written `Operation '<key>' is not authorized`,
which named the operation only as a developer knows it and said nothing about which of the two questions
was answered — and altea already calls `assertOperationAllowed` both ways (`inUserInterface: false` from
the graph's execute/delete/construct paths, `true` from operationServer, PackageLogic and
ExcelImportLogic). So `operationAllowedMessage` came over beside the assert, as Signum has it.

`Logs` is the caption of the `OperationSymbol.Logs()` expression — the operation history read from the
OPERATION's end rather than the entity's, the mirror of `Entity.OperationLogs()`. The surface exists:
`SymbolLogic.start` gives every symbol type its own query (`sb.include(ctor).withQuery()`), so
OperationSymbol has a search page for the token to hang off. Declared in `data/operationLog.ts` beside the
four on `Entity`, stamped in `server/operationLogic.ts`, registered in `OperationLogic.start`. Verified
against the eastwind database: the token lowers to an EXISTS sub-query.

### D3 — `SearchMessage` — **DONE**

altea declared 82 of Signum's 114. Nine of the 32 missing members had functionality behind them and were
ported first; **the remaining 23 are declared too, and the container is complete.**

The first pass declined those 23 on the grounds that they are dead **in Signum** as well — only 88 of its
114 members are referenced anywhere in the framework or the extensions. That reasoning does not hold for a
FRAMEWORK: an application replacing altea's column editor, rule set or finder has to be able to say these
things in the user's language, and a member the framework never declares is unavailable to it. "Nothing in
altea renders it" is a statement about altea, not about the container's surface.

What the first pass DID establish stands and is worth keeping, because it says what each member is for and
which of them still want functionality behind them — so the table below is now a map of where each one
lands, not a list of refusals.

#### Ported

| Member | What it now does |
| --- | --- |
| `GroupPrefix` | The label over a filter GROUP's own token. Both frameworks rendered a hard-coded `Prefix:` two lines from the declared member; `client/SearchControl/FilterBuilder` now says it. |
| `SelectRow0_` | The result row checkbox's `aria-label`. Same story: `` aria-label={`Select row ${i + 1}`} `` in Signum and in altea, with the member unused. |
| `FilterGroupInvalidMixedOperations` + `Error` | A filter group holds ONE value for every condition under it, so `is in` (an array) and `equals` (a scalar) cannot share it unless `pinned.splitValue` splits it. Signum raises this from its two group multi-value rules, neither of which altea ports; altea has one group rule, so the guard is asked there, from the new `hasMixedListOperations` in `client/FindOptions` (beside `isList`, which it reads). |
| `SmartSearchDescription` | Brought the full-text value editor over with it: `FilterTextArea` + `ComplexConditionSyntax` + the `TextArea` / `VectorSmartSearch` rules in `client/FinderRules`. The six full-text operations take a whole expression in the dialect's own syntax, and altea's server supports them (`server/fullTextSearch`) — they were being edited in a one-line box with no syntax help. `SmartSearch` is the one with no syntax to show, which is what the message says. `isFullTextSearch` / `isComplexFullTextSearch` join the predicate above in `client/FindOptions`. |
| `_0Rows_N` | The Excel export's pagination selector (`@altea/altea-office-template`'s `ExcelMenu`), which said `_0Results_N`. An export writes ROWS, and for a grouped query that is not the result count. altea keeps its own fix to Signum's call — it passes the count being shown to `forGenderAndNumber`, where Signum always passes `totalElements`. |
| `Query0NotAllowed` | `QueryAuthLogic`'s refusal, which was a hand-written `Query '<key>' is not authorized`. It reaches the end user through the error modal, so it is localized. |
| `NoResultsFoundBecauseTheRule0DoesNotAllowedToExplore1WithoutFilteringFirst` + `NoResultsFoundBecauseYouAreNotAllowedToExplore0WithoutFilteringBy1First` | The query-auth rule that refuses an unfiltered search — see below. |

#### The unfiltered-search rule

A type whose type-auth FALLBACK is `None` is reachable only through its condition rules, and a QUERY-AUDITOR
condition among them (`TypeConditionLogic.registerWhenAlreadyFilteringBy`, already ported) decides from the
CALLER'S QUERY rather than from the row: *you may read these rows because you already pinned them to
something you are allowed to read*. An unfiltered search over such a type therefore matches nothing — not
because nothing is there, but because nothing was asked for, and "No results found" is then a lie. The
canonical case is the operation log: one table across the whole application, so a role that may read it at
all could otherwise read the audit trail of rows it cannot see.

Three pieces, mirroring Signum:

- **server** — `AuthReflection` stamps `TypeMetadata.queryAuditors` (the auditing conditions' keys) on a type
  whose `WithConditions.fallback` is `None`. Declared by the interface expansion in `altea-auth/data/Rules`,
  beside `maxTypeAllowed`. The type loop had to be restructured: it used to `continue` before the stamp for
  any type at Write, and a condition rule may well grant Write over a `None` fallback;
- **registry** — `AuthAdminClient.registerQueryAuditorToken(queryName, token, typeCondition)`, the pair that
  lets the message name the very token to filter by. `@altea/altea-diff-log` registers `OperationLog.Target`
  beside the condition its logic registers. It lives in `AppContext.clientState`, so the re-registration
  every credential change triggers replaces it instead of appending to it (Signum clears it through
  `clearSettingsActions`);
- **client** — `queryAuditorNoResultMessage` in `AuthAdminClient`, which renders the generic message when no
  token is registered for the query and the specific one when there is. In both cases an `EqualTo` filter
  that already pins something means the search really did match nothing, and it says nothing.

Divergences from Signum, and why:

- it is a **global** `Finder.onNoResultMessage()` handler, not a per-type `QuerySettings.noResultMessage`
  assignment. Signum can snapshot `getAllTypes()` inside `AuthAdminClient.start`; altea cannot, because
  `loadReflectionMetadata` runs AFTER the client modules register (MainPublic's `reload()`), so at `start()`
  nothing yet knows which types the role is restricted on. Reading the blob at render time also keeps the
  answer right after a login or an impersonation, which Signum's snapshot does not. The per-query
  `noResultMessage` already existed in core and still wins; the global list is consulted after it;
- Signum's `similarToken` (which strips a leading `Entity.`) is plain string equality, because altea's
  tokens are rootless already — the same collapse `client/FindOptions` records;
- Signum renders the token through `QuerytokenRenderer`, which resolves it against the QueryDescription.
  altea has none, so the token is resolved hop by hop against the query's own token tree (`QueryToken
  .subTokens` is synchronous), falling back to the raw key when a registration has gone stale.

#### Declared, with nothing rendering them yet

All 23 are in the container. What each is FOR, and what would have to exist for altea to render it:

**Waiting on the column editor** — Signum renders these from `ColumnBuilder.tsx` and
`ColumnEditorModal.tsx`; altea has no `ColumnBuilder`, and its `ColumnEditorModal` is a documented stub
(`show()` resolves `false`). That modal is its own port item (see below); the members are declared and
waiting for it: `AddColumn` · `Orders` · `HiddenColumn` · `ChooseTheDisplayNameOfTheNewColumn` · `Name` ·
`NewColumnSName` · `Rename` · `NoColumnSelected` · `NoFiltersSpecified`.

> **Port item — `ColumnBuilder` + a real `ColumnEditorModal`.** Nine of the members above are its
> vocabulary. Recorded rather than half-built: it is a feature, not a string.

**Signum's second spelling of something altea already renders elsewhere.** Declared, because an
application porting Signum code may reference either spelling, but altea keeps rendering its own:

- `NoActionsFound` — `JavascriptMessage.noActionsFound`, which the contextual menu renders;
- `Query0IsNotAllowed` — the same `[Description]` as `Query0NotAllowed`, which is the one wired above.
  Signum declares both and uses neither (`ChartMessage` has its own third copy);
- `Create` · `ViewSelected` · `ThereIsNo0` — superseded by `CreateNew0_G` / `EntityControlMessage.Create` /
  `OperationMessage.Create`, and by the toolbar altea does render.

**A developer diagnostic** — `Query0NotRegistered`. Declared; altea's `QueryLogic` still THROWS a raw
`Error` naming the API to call, which is what the reader of that message needs and a translation would
lose (the same call as `ConsoleMessage` / `SynchronizerMessage` in section E). The declared text names
altea's registration API rather than Signum's `QueryLogic.Queries`.

**Leftovers from a UI Signum itself no longer has** — no reference anywhere in the framework or the
extensions, and nothing in altea's search UI renders a literal for them either (checked). Declared so an
application that DOES build that UI has the vocabulary:

| Member | Where it came from |
| --- | --- |
| `Find` · `FinderOf0` | The old finder WINDOW's title. altea's `SearchModal` is titled with the type's plural nice name. |
| `Of` | A bare preposition, which only a translation of the whole sentence it belonged to can place. |
| `PinnedFilter` | A heading for the pinned-filter editor; `EditPinnedFilters` / `PinFilter` / `UnpinFilter` are what both frameworks actually render. (Signum's `PinnedFilter` TYPE is unrelated.) |
| `WhenPressedTheFilterWillTakeNoEffectIfTheValueIsNull` · `WhenPressedTheFilterValueWillBeSplittedAndAllTheWordsHaveToBeFound` | Superseded by `SplitsTheStringValueBySpaceAndSearchesEachPartIndependentlyInAnANDGroup` / `SplitsTheValuesAndSearchesEachOneIndependentlyInAnANDGroup`, which altea has and renders, and by the pinned `active` enum's own nice names. |
| `_0FiltersCollapsed` | A count badge for collapsed filters. Neither framework's `FilterBuilder` has one. |
| `Options` | A dropdown heading that no longer exists. |

Still deferred, and now the only thing standing between altea and the `FilterGroup_TextArea` rule: the two
group multi-value editors (`FilterGroup_MultiValue` / `FilterGroup_MultiEntity`). A full-text GROUP falls
back to the single `FilterGroup` editor.

### D4 — `CultureInfoEntity.IsNeutral` — **DONE**

The member already existed as a `@quoted` method; what was missing is that nothing registered it, so it
was reachable only from server code (`CultureLookup.names(isNeutral)` in memory) and no culture search
could filter on it. `CultureInfoLogic` now registers the `IsNeutral` expression, captioned by the new
`CultureInfoMessage.IsNeutral` — F1's rule, since a `@quoted` method has no `<Member>` to translate.
`!name.includes("-")` lowers to `NOT (strpos(name, $1) >= 1)` on PostgreSQL and
`NOT (CHARINDEX(@p0, Name) >= 1)` on SQL Server (`test/server/linq/cultureIsNeutral.test.ts`).

The premise "the culture dropdown filters on it" was WRONG, and nothing was wired to the client:

- Signum's endpoint does not expose the filter either. `/api/culture/cultures` returns every row and
  `CultureClient.getCultures(isNeutral)` filters in memory, off the NAME (`isNeutral == !a.name
  .contains("-")`) — not off the `IsNeutral` column. So there is no server-side filter to port.
- Signum's `CultureDropdown` passes `false`, i.e. it offers only REGION-SPECIFIC cultures. Applied to
  altea that would empty the dropdown: altea's catalogue is the set of loaded translation files
  (`de`, `es`, plus the default `en`), all of them neutral. Signum's own Translation module passes `null`
  (no filter), which is what altea already does everywhere.

The token is therefore a SEARCH-page filter, which is what the entity keeps the member for.

### D5 — the IMPERATIVE validations behind the messages — **DONE**

Completing `ValidationMessage` raised the obvious next question: what does Signum DO with each member?
Every `ValidationMessage.*` call site in Signum and Southwind was walked and checked against altea. Most
were already ported — Signum.Workflow's twenty-one are all there, Signum.Mailing.MicrosoftGraph's three
are the model the others should copy. What the sweep found falls into three kinds.

**Rules altea did not have, now ported.** Each is on the field it is about, with Signum's message:

| Signum | altea |
| --- | --- |
| `RoleEntity.PropertyValidation` — the three trivial-merge branches | `altea-auth/data/Role.ts`. The file said they "land with the authorization phase"; the phase landed long ago and the checkbox IS rendered, so every one of these states was reachable by hand. Signum passes ONE argument to the two-placeholder `_0ShouldBe1`, leaving a literal `{1}`; both halves are filled here. Its inheritsFrom message says "greater than 2" where the check is `< 2` — the check is the rule. |
| `NoRepeatValidatorAttribute.ByKey(ConditionRules, …)` ×4 | `altea-auth/data/Rules.ts` — six places (the three rule ENTITIES and the three pack MODELS; altea has one concrete pair per dimension where Signum has a generic). Two condition rows naming the same SET of conditions do not conflict loudly: last-match-wins makes the later silently shadow the earlier. `@noRepeatValidator` already took the key selector Signum's `ByKey` is. |
| `QueryFilterEmbedded.PropertyValidation` — the three MANDATORY branches | `altea-user-assets/data/Queries.ts`. A GROUP needs its group operation, a LEAF needs both its token and its comparison. The fourth set of branches asks `QueryUtils`/`QueryDescription` what a token can be filtered by, which is a server-side catalogue altea does not have. |
| `QueryTokenEmbedded.PropertyValidation` | Same file. Reports the PARSE error when there is one, "is not set" otherwise. CLIENT-ONLY, where Signum checks on both tiers: the resolved `token` is filled by Finder's TokenCompleter and is neither a column nor serialized, so a tier-blind rule would refuse every server-side save. |
| `BigValuePartEntity.PropertyValidation` — all three branches | `altea-user-queries/data/DashboardParts.ts`. They turn on whether the OWNING dashboard is entity-scoped, which needed a parent chain: `@altea/altea-dashboard` now marks `DashboardEntity.parts` and `DashboardEntity_Part.content` `@bindParent` (Signum marks both) and exposes `tryGetDashboard` for the two hops. The header comment saying the rules were dropped for want of a parent pointer is gone. |
| `HealthCheckEmbedded.PropertyValidation` | `altea-user-queries/data/UserQuery.ts` — a health check with neither threshold reports nothing. |
| `DashboardEntity.PropertyValidation` — the `CacheQueryConfiguration` branch | `altea-dashboard/data/Dashboard.ts`. A cached dashboard is one snapshot for everybody, so it cannot also be an entity widget. |
| `EmailTemplateAddressEmbedded.PropertyValidation` — the "template has no query" branch | `altea-email/data/EmailTemplate.ts`, on both address classes and on `FileTokenAttachmentEntity` (Signum's `FileTokenAttachmenEntity.cs` uses the same wording for the same condition). Needed `@bindParent` on the template's `from` / `recipients` / `attachments` and on the attachment row's generator — all four of which Signum marks. Its second FileToken branch (the token's type must be assignable to `IFile`) needs the RESOLVED token's type, which only the client holds; the generator's runtime check stands in. |
| `DynamicTypeLogic`'s duplicate-property guard | `altea-dynamic/data/DynamicType.ts`. Signum throws it from the Save operation; it is a VALIDATION here, on the member it is about, so the author hears it while editing. Case-insensitive, as Signum's `GroupToDictionary(a => a.Name.ToLower())` is. |
| `AddressEmbedded.PropertyValidation` (Southwind) | `eastwind/app/customers/Customer.data.ts` — a postal code is mandatory except in Ireland. The field stays nullable; the rule is about the country, not the column. |

**A validation that existed but never RAN.** `altea-dashboard`'s `validateEmbeddedInEntity` was an
exported free function with zero call sites anywhere in the repository — the rule read as ported and
enforced nothing. It is the `@validate` on `embeddedInEntity` now. It also said Signum's sentence with two
`DashboardMessage` members of altea's own invention, written when core carried neither half; core carries
both now (`_0IsNecessary` / `_0IsNotAllowed`), so the two invented members are gone with it.

**Checks that were there, saying it in raw English.** A user-visible string has to be a localizable
member, and so does every NAME spliced into one:

- `eastwind/app/orders/OrderLogic.server.ts` — `"Details is empty."` → `_0IsEmpty`, and `"Only shipped
  orders can be cloned."` → the state message, through the new `inState`;
- `altea-processes/server/ProcessLogic.ts` — the Retry guard's English sentence → `inState`;
- `altea-chart/data/ChartParameter.ts` — a template literal → `_0ShouldBe12`;
- `altea-email/data/EmailMessage.ts` — two rules returning the literal `"{0} should be empty"`, which
  reached the user with the `{0}` still in it → `_0IsNotAllowedOnState1`, which is what Signum's
  `StateValidator` says. The same un-substituted `{0}` idiom was in `Email.ts` and `EmailTemplate.ts`
  five more times (Signum has it too, at `EmailMessage.cs:247`) and now passes the field's nice name;
- `altea-scheduler/server/HolidayCalendarLogic.ts`, `altea-auth-azuread`, `altea-auth-openid`,
  `altea-auth-windowsad` — English property LABELS spliced into a translated sentence → `nicePropertyName`
  / `fi.niceToString()`. AzureAD's `niceFieldName` de-camel-cased the TypeScript identifier, so it also
  ignored the `@niceName` overrides two fields above it.

**Two helpers came out of this, both where Signum keeps them.** `OperationLogic.InState` →
`inState` in `server/operation.ts` (the graph's own `stateError` delegates to it, so a transition refused
by the graph and one refused by a hand-written guard read identically — a ConstructFrom has no
`fromStates`, which is why Signum needs it at all), and `IsSetOnlyWhen` → `isSetOnlyWhen` in
`data/validators.ts`, which three packages had written out by hand.

**Not applicable.** `DisableLogic` / `TreeLogic`'s DisabledMixin guards and
`DisconnectedMachineEntity` have no altea counterpart (section E). `SendEmailTaskLogic`'s two
`_0ShouldBeOfType1` branches and `FileTokenAttachment`'s second branch need a server-side
`QueryDescription`/implementations list that altea does not have. `EntityJsonConverter`'s
`SetTemporalError` is structural: C# cannot assign null to a non-nullable property, so Signum reports it
specially — altea assigns it and the implicit NotNull reports it in the ordinary pass.

**Left for its owner.** `Signum.Agent/SkillCustomizationEntity.cs:28` (`SkillCustomization` is required
when `Key` is null) has no counterpart in `altea-agent/data/SkillCustomization.ts`. Not touched: that
package was being edited concurrently.

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

---

## G. The deletion sweep — using the sync's prune as a feature detector

`convert-translations` copies Signum's file wholesale; `stub-translations` then rewrites it from what the
running altea process DECLARES. **Everything the second step drops is a name Signum has and altea has no
counterpart for**, which makes the difference a feature-gap detector. The strings themselves are worth
nothing without the code behind them — that is the only reason to read this list.

A full re-copy of all 83 mapped files (2026-09-19) settled the other question for good: it **gained 0**
entries, and a near-miss scan (case flips, the `_0` convention, renamed types) found **0** more hiding
under unmatched names. Signum has nothing left to give. It also OVERWROTE 104 altea-only translations,
which had to be restored from a snapshot — so the round trip is not idempotent, and anyone repeating it
should snapshot first.

**The detector over-reports**, and every entry has to be checked against the code before it is believed.
Confirmed false positives so far, all of them "implemented differently":

- `CultureInfoEntity.IsNeutral`, `OperationLogEntity.Duration` — altea moved these from a PROPERTY to a
  message container, because a `@quoted` method is not a PropertyRoute and has no `<Member>` to hold a
  translation (see F1).
- `QueryTokenMessage.TimeOfDay` — altea declares it, under `QueryTokenDateMessage`.
- `HtmlEditorMessage` — routed to `@altea/altea-html-editor` by `translationFiles.txt`; core is right not
  to declare it.
- **`NumberUnitsMessage`** (10 members) — Signum hand-rolls a K / M / B / T suffix table and appends it in
  `NaturalLanguageTools.FormatCompact`. altea's `K` number format already does this through
  `Intl.NumberFormat`'s `notation: "compact"`, which is localized by CLDR — German "1,23 Mio.", Spanish
  "1,2 mil". Porting the enum would replace a better implementation with a worse one. NOT a gap.
  (Worth knowing: Signum's own `ToStringWithCompact` has no caller in Signum or Southwind.)

### Core (`@altea/altea`) — the real gaps

| Feature | Evidence | State |
|---|---|---|
| Query-token captions | `Count`, `HasValue` / `_0HasValue`, `As0` / `_0As1`, `And` | **DONE** — three tokens built their caption by concatenating English at runtime |
| SmartDateTime | `DateTimeMessage` (21) — really TWO features: 14 duration-prose members (`_0Days`, `_0Hours`…) and 5 relative-date ones (`Today`, `Yesterday`, `Last0`, `This0`) | open |
| Search-control vocabulary | `JavascriptMessage` (21, after the cross-container check) | **DONE** — members declared |
| Entity-line UI controls | `EntityControlMessage` (9, after the cross-container check) | **DONE** — members declared |
| DisabledMixin | `DisabledMixin` + `DisabledMessage` + `DisableOperation` (4) | open |
| Long tail | `SelectorMessage` (5), `EngineMessage` (3), `OperationMessage` (3), `FrameMessage` (2), `NormalControlMessage`, `QueryTokenDateMessage` (2) | **DONE** — members declared |

### Core — what is LEFT, and why each needs a decision rather than a declaration

The member-level work is done: 45 members across seven containers now exist, on the same
framework-surface argument as the ValidationMessage sweep. A CROSS-CONTAINER check went in first, and
it matters: altea keeps several names Signum has but under a different container — the entity-line
button titles (Create / Find / View / Remove / MoveUp / MoveDown) live in `EntityControlMessage` where
Signum splits them between that and `JavascriptMessage`. Comparing container-by-container reported all
of those as missing. That check alone cut `JavascriptMessage` from 28 to 21 and `EntityControlMessage`
from 11 to 9.

What remains is NOT vocabulary an application reaches for. It is a caption for an altea UI control or
engine feature **that does not exist**, and declaring it would put a string in the file with nothing
behind it — the state this whole exercise exists to get out of.

| Left | What it really is | Size |
|---|---|---|
| `DateTimeMessage` | TWO features: 14 duration-prose members (`_0Days`, `_0Hours`…) for rendering a Duration as text, and 5 relative-date ones (`Today`, `Yesterday`, `Last0`, `This0`) — Signum SmartDatePattern / SmartShortDatePattern | 21 |
| `ContainerTokenKey` + `QueryTokenMessage.Operations` | the OPERATIONS / QUICKLINKS container tokens. altea has no OperationsContainerToken at all, so the enum would name containers that cannot be built | 3 |
| `DisabledMixin` + `DisabledMessage` + `DisableOperation` | the framework-wide enable/disable feature. The ValidationMessage sweep reached the same conclusion from the other side: DisableLogic guards, no altea counterpart | 4 |
| `FontSizeMessage`, `ContainerToggleMessage` | captions for a font-size control and a compress/expand container toggle. Neither control exists in altea | 6 |
| `SystemTimeProperty` | a time-machine token shape altea does not offer | 2 |
| `IEntity`, `EmbeddedEntity`, `ModelEntity`, `ModifiableEntity` | altea HAS these classes; it simply never registers them as localizable, so their nice names humanise. The smallest real gap here | 4 |
| `LiteMessage`, `PaginationMessage`, `VoidEnumMessage` | small vocabulary; `VoidEnumMessage` is the "-" a null enum renders as | 6 |

Two more false positives found on the way: `MarkdownMessage` and `EmailOwnerData` both exist in altea —
in `@altea/altea-markdown` and the directory-login packages respectively. That brings the confirmed
false-positive count to seven, which is the headline caution for every module still to be swept.

### altea-auth — swept

Detector output: Signum declares 57 types here; 13 had no altea counterpart and 7 more were missing
members. After checking each against the code, **most of it is noise**, and the same handful of
categories account for all of it:

- **C# generics** — `AllowedRule\`2`, `BaseRulePack\`1`, `ConditionRuleModel\`1`, `RuleEntity\`1`,
  `WithConditionsModel\`1`, `AllowedRuleCoerced\`2`. altea collapses these into CONCRETE classes (there
  are no generic entities), so the backtick-arity names can never match. 6 false positives.
- **Moved to core** — `BasicPermission`, this session.
- **Implemented differently** — `RoleMappingEmbedded` is a `@part` ENTITY in altea, not an embedded.
- **Renamed by design** — `RuleTypeConditionEntity.Order` and its two siblings are now `rowOrder`, and
  `@rowOrder` sets `avoidTranslation`, so they are deliberately absent. 3 false positives.

**What was real:** four raw English literals in the type-rules grid (`title="Add condition"`,
`"Remove condition"`, `"Master"`, `"Owns parts: …"`) and two `aria-label="Close"`. Fixed — the first
two are Signum members, so its German came with them; the other two are altea-specific.

**Left, and needing a decision:**

| Left | What it really is |
|---|---|
| `AuthThumbnail` | altea DECLARES the enum and never uses it. Signum renders it as the roll-up badge on each rule-pack drill-in link — "are this type's property / query / operation rules all default, mixed, or none". altea has the drill-in but no badge, so the enum is vocabulary for a feature that is not there |
| `TypeAllowedBasic` | declared and compared, never RENDERED. Registering it would add three translatable members nobody reads; Signum translates it because its grid shows the DB/UI split as text |
| `AuthAdminMessage`, ~28 more | the rest of Signum's admin vocabulary (`CopyFrom`, `UsedByRoles`, `PleaseSaveChangesFirst`, `SelectTypeConditions`, the cycle/trivial-merge diagnostics…). Each names an admin affordance; whether altea wants the affordance is the question, not whether it wants the string |
| `UserLiteModel`, `AuthTokenConfigurationEmbedded`, `OperationTypeEmbedded` | types altea does not model |

**A registration trap worth remembering**, found here: none of the six auth enums calls `registerEnum`,
yet four of them (`TypeAllowed`, `PropertyAllowed`, `QueryAllowed`, `OperationAllowed`) are in the
translation file anyway — the quote-transformer auto-registers an enum that a reflected FIELD
references. The two that no field references (`TypeAllowedBasic`, `AuthThumbnail`) silently fall out.
So "is it registered?" cannot be answered by grepping for `registerEnum`.
