# Signum.UserAssets → @altea/altea-user-assets

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.UserAssets/`

A USER ASSET is a user-authored, XML-portable entity — a UserQuery, a UserChart, a Dashboard, a Toolbar, a
template — identified by a stable uuid so it can be exported from one database and imported into another.
This package owns three things nothing else does: the shared value embeddeds every stored query definition
is built from, the XML import/export engine, and the TOKEN MIGRATIONS that keep a stored token resolving
after a schema rename.

## The asset's identity IS its primary key

Signum gives each asset an ordinary int PK plus a `Guid Guid = Guid.NewGuid()` field, and `IUserAssetEntity`
carries that field. altea declares the asset `@primaryKey("uuid")` instead, so the marker interface carries
nothing at all — the asset's `id` is its portable identity, on both tiers, from the moment it is
constructed. One value where Signum has two, and no way for them to disagree.

`ToXml(ctx)` / `FromXml(element, ctx)` are members of the entity in Signum, which is possible because a
Signum entity may reference `System.Xml.Linq`. altea entities are ISOMORPHIC, so each asset type registers
its (de)serializer with `UserAssetsImporter.register` on the SERVER instead. XML is produced and parsed with
fast-xml-parser (the library altea-auth's AuthRules XML already uses), attributes prefixed `@_` for the
builder and read back as bare keys.

Not ported: the advanced lite-conflict / custom-resolution machinery (`LiteConflicts`,
`CustomResolution`) — the preview is New / Different / Identical. Referenced queries and types are resolved
by KEY at import rather than included; dependent user assets (a chart's CustomDrilldowns) ARE included
recursively through `ctx.include`.

## A collection row is matched by its own id, never by position

Signum declares nine user-asset collections `[PrimaryKey(typeof(Guid))]` and says why in a comment — *"the
row id identifies the element in the XML"* — writes it per row on export (`SelectWithRowId`) and matches
rows by it on import (`SynchronizeRowIds`). Both halves are `syncRows` / `rowGuid` here, and the
SelectWithRowId half is trivial: altea's collection element IS an entity with its own primary key.

The costs of matching by POSITION are why those uuid PKs exist, and they are all silent: re-importing an
unchanged asset rewrites every row, REORDERING one rewrites every row after the move, and anything keyed to
a row — a per-instance translation, whose key includes the row's own lite — is orphaned by the re-import.

Signum's back-compat is kept. A file with no `Guid` on any element still imports by position, so an older
export is not reported as a change; a file where only SOME rows carry one is refused rather than
half-applied. The `sync` callback also receives the element's INDEX, for state that depends on position
rather than on the XML (Signum notes UserChart binding each column's ScriptColumn that way).

See the CLAUDE.md bullet for the thirteen tables this covers, the three redundant `guid varchar` columns it
retired, and `migrateRowGuids.ts`.

## The value embeddeds

`QueryTokenEmbedded` and `PinnedQueryFilterEmbedded` are owner-agnostic: they flatten into whichever owner
table embeds them, so they live in this shared package rather than in altea-user-queries.

Signum's `[Ignore] QueryToken token` + `Exception? parseException` are transient members it fills on
RETRIEVE. altea's client resolves a token locally from `tokenString` (`Finder.TokenCompleter` /
`parseSingleToken` — there is no server QueryTokenTS round-trip), so both are `@column(false)
@serialize(false)` and client-filled, and the server only ever sees the string.

`FilterValueString` is the value↔string half of Signum's server-side `FilterValueConverter`, moved into the
DATA layer because both tiers need it — the SearchControl editors on the client, `QueryFilterUtils` on the
server. Still passed through unchanged as raw strings: the `[CurrentEntity]` / `[CurrentUser]` special
expressions (each caller resolves them against its own context — see below).

## The filter-value converters

A stored filter value is a STRING, and not always the value: it may be an EXPRESSION that means something
different every time the asset runs. Signum keeps one ordered list of rules for that
(`FilterValueConverter.SpecificConverters`) and asks each in turn until one claims the value; altea's is
`data/FilterValueConverter.ts` over `data/FilterValueConverters/`, with `FilterValueString` reduced to the
façade the two tiers call — the loop plus Signum's own primitive fallback.

Two of Signum's four rules are here. `LiteFilterValueConverter` is the entity reference (`"Order;42"`) that
was inlined in `FilterValueString` before the family existed, and `SmartDateTimeFilterValueConverter` is the
relative date: `yyyy/mm/dd hh:mm:ss` where each part is its own PATTERN ("whatever it is now"), a `+n` /
`-n` shift, or a literal — plus `max` and a weekday (`mon`…`sun`, optionally `+n` / `-n`) in the day
position. It is what makes a saved query mean "since the start of this month" rather than freezing on a
date, and Southwind's own `UserAssets.xml` stores exactly two spellings of it: `yyyy/mm/01 00:00:00` on
three month-axis charts and `-1/mm/dd 00:00:00` on "Evolution By Employee".

`CurrentEntityConverter` / `CurrentUserConverter` are NOT ported. Both read an ambient "the entity this is
being rendered for" / "the logged-in user" out of a thread variable, and the callers that need them already
resolve the two strings themselves against a context this package cannot see (`UserChartClient.parseValue`
against the chart's scope entity and `AppContext.currentUser`). Porting them means giving altea that
ambient context first.

### Divergences

- **The parts are mixed with the clock INDEPENDENTLY and then carried** — Temporal changes nothing about
  that, because the grammar is not a duration: `-1/mm/dd` is "this day and month, a year ago", not "365
  days ago", so it cannot be `now.subtract({ years: 1 })`. What Temporal does replace is the normalization
  underneath: `DateTime.DaysInMonth(y, m)` is `PlainDate.from({year, month, day: 1}).daysInMonth`, and
  `new DateTime(y, m, now.Day)` — which THROWS on the 31st of a 30-day month — is `PlainDate.from(…,
  { overflow: "constrain" })`.
- **The weekday walks a MONDAY-based week.** Signum starts it at `CultureInfo.CurrentCulture.FirstDayOfWeek`;
  altea's `weekStart` is Monday everywhere (data/globals/dateTimeExtensions, matching the SQL the WeekStart
  token emits), so `sun` is the END of the week here and, under en-US, the START of it there.
- **A string without the `a/b/c d:e:f` SHAPE is "not mine", where Signum calls it an error.** Signum can
  afford that because it writes EVERY date filter value through this converter, so a stored date is always
  in the shape. altea does not (next bullet), and an error would reject every ISO value already stored.
- **Formatting a date back to a relative expression is NOT wired into the toString direction**, which is
  where Signum puts it. Signum has no way for a user to say whether a saved date filter is meant absolutely
  or relatively, so it guesses on every save — a filter for the 19th saved on the 19th is stored
  `yyyy/mm/dd 00:00:00` and means the 19th of NEXT month next month. altea's filter editor has an explicit
  value↔expression toggle, so the choice is the user's; the toggle seeds the box with
  `smartDateTimeExpression(…)`, which is Signum's `TryGetExpression` verbatim and what the round-trip tests
  drive. The other reason is that `stringifyFilterValue` is reused by callers that are not stored filters
  at all — altea-machine-learning codifies a predictor column's KEYS with it — where a relative spelling
  would simply be wrong.
- **`isValidExpression` answers the expression, not a Type.** Signum returns the .NET type the expression
  yields and checks it is convertible to the target; there is no runtime Type to answer with in the data
  layer, and every caller only wants "valid, or why not".
- **The parse errors are localized** (`UserAssetQueryMessage._0MustBeBetween1And2` /
  `._0IsNotAValid1Try2Instead`), where Signum's are raw English literals. The part that is wrong is named
  with `QueryTokenDateMessage.Year` … `.Second` rather than its pattern, because a bare `mm` cannot say
  whether it means the month or the minute.
- **`parseFilterValue` takes the token's `typeName`** as well as its FilterType. Both `PlainDate` and
  `PlainDateTime` are FilterType "DateTime", and the resolved value is an ISO STRING (which is what an
  altea date filter value IS on both tiers — `Finder.parseFilterValues`), so without it a date-only editor
  would be handed a timestamp.

Two Signum bugs, not reproduced: `Extensions.DivMod` is floor division EXCEPT on an exact negative
multiple, where `-60 DivMod 60` answers `(-2, 60)` — a remainder equal to the divisor, which reaches
`new DateTime(…, second: 60)` and throws (plain floor division here); and the "not a valid day" message
lists `(max|sun|mon|tue|wed|fri|sat|)`, missing `thu` and with a stray empty alternative.

`SmartDateTimeSpan.TryParse` also opens with an "{0} has no value" case that cannot happen: every group of
the grammar is `.+`, so a part that matched at all is non-empty. Dropped rather than carried as a message
key nothing would show.

`QueryFilterUtils.toFilterList` turns the flat, indentation-encoded rows of a stored filter tree into the
engine's nested Filter list. It works for ANY owner's rows because they are all `QueryFilterBaseEntity` —
it was parked in altea-email while that was the only server consumer, and moved here once
altea-office-template became the second.

## Token migrations

A stored token is a STRING, so renaming a field or a query breaks every asset that walked through it — and
the schema sync does not notice, because those tokens are data. Signum's answer is a versioned
`.tokens.json` beside the SQL migrations, recording each rename decision and replaying it.

**The JSON is a CONTRACT.** A file written by either framework must be readable by the other, since the
whole point is that an application migrating between them keeps its recorded history — so the bucket names,
their shapes and the string-or-array encoding (one candidate is a bare string, several an array) are
Signum's exactly, and an absent bucket is omitted rather than written as `null`. C#'s
`Dictionary<string, X>` is a plain object, so key order is insertion order rather than .NET's unspecified
one; harmless, and it makes a diff of two recorded files readable. `StringOrArray` needs no converter here:
`string | string[]` IS the wire shape.

**The two modes are asymmetric on purpose.** RECORD is interactive and saves nothing — it walks every
asset, asks about each token it cannot resolve, and writes the answers out. APPLY is silent and saves per
entity — it replays those answers and must not prompt, because it runs where nobody is watching. That is
why a miss in Apply mode is an ERROR rather than a question.

`tryResolveParts` is the interesting part: it walks the token's segments against the LIVE schema and at
each position consults the rename history for that position's own bucket — keyed by the QUERY at the root
and by the current TYPE further in. History is chain-composed file by file rather than flattened, so
`V1: A→B` + `V2: B→C` lands at C in one pass, and each file is looked up under the name its key had at that
file's era. A multi-candidate entry is tried in order, recursing, so the first candidate that resolves ALL
the way wins.

### Divergences

- **`QueryDescription` is gone**, so every entry point takes the QueryName and resolution goes through the
  root token: `QueryUtils.SubToken(result, qd, options, part)` becomes
  `(result ?? rootToken).subToken(part, options)`. `result == null` still means "at the query root", so the
  shape of the algorithm is unchanged.
- **staleness is DISCOVERED, not read off the entity.** Signum's retrieve fills
  `QueryTokenEmbedded.ParseException` and `FixToken` short-circuits when it is null; here those members are
  client-filled and the server has none, so `fixToken` simply tries to resolve the string and a throw IS
  the staleness signal. Strictly more reliable — the flag cannot be stale — and it is why there is no
  `forceChange` fast path to protect.
- **the interactive rename picker is the SYNCHRONIZER's own** (`Replacements.selectInteractive`), not a
  second hand-rolled one: same numbered list ordered by Levenshtein distance, same "n: None", same paging,
  so the global auto-replacement hook works here for free. Signum re-implements it complete with its own
  `Console.LargestWindowHeight - 11` arithmetic — there is no reason for a developer to meet two different
  rename prompts in one session.
- `DelayedConsole` (buffer the entity/field headers, flush only if something is actually asked) is not
  ported: it exists to keep a quiet run quiet, and altea's callers already print one line per asset.
- `MigrationsDirectory` is a SETTABLE slot rather than a read of `SqlMigrationRunner.MigrationsDirectory`,
  because this package must not depend on @altea/altea-migrations — a user-assets app need not have
  migrations at all. The app points both at one directory, which is what keeps a `.tokens.json` beside the
  `.sql` that caused it.
- `PermissionLogic.RegisterPermissions` has no counterpart (a declared `init()` symbol is picked up by the
  symbol synchronizer), and it was an odd line in Signum anyway: this module does not use that permission.
- every prompt is ASYNC, so the runner is async top to bottom; the writes run through `ExecutionMode.global`
  (Signum's runner is a console tool with no user, so authorization never applied there either).

### ONE walker where Signum has four

`UserQueryLogic.ProcessUserQuery`, `UserChartLogic.ProcessUserChart`, `EmailTemplateLogic` and
`WordTemplateLogic` each carry their own ~200-line copy of the same filter / column / order / value walk,
because in Signum those row types are EMBEDDED inside four unrelated MLists with no common handle. Here
they are `@part` rows over a shared `QueryFilterBaseEntity`, so `TokenSyncWalker` is written once and each
subscriber keeps only what is genuinely its own — a chart's parameters, a template's text nodes, a user
query's paging and system time.

The behaviour is Signum's decision for decision: which SubTokensOptions each position gets, that a filter
may be REMOVED while a column's summary token is merely cleared, that a value fix RE-RUNS the value check
(Signum's `goto retry`), and that Skip/Delete abandon the whole asset immediately.

### The pass over a template's BODY

Where `@[Customer.Name]` lives — Signum's `TemplateSynchronizationContext` plus a `Synchronize` on every
value provider — and what the `Member` and `Global` buckets are for. It is ported on both substrates:
`altea-templating/server/TemplateSync` is the context, @altea/altea-email drives it over each message's
Subject and Text, and @altea/altea-office-template over the .docx/.pptx/.xlsx DOCUMENT plus the file name.
See [Templating.md](Templating.md) and [OfficeTemplate.md](OfficeTemplate.md).

## Owner scoping

`UserAssetOwnerAuth` is the owner-scoping half of Signum's UserQueryLogic / UserChartLogic / DashboardLogic
— `RegisterUserTypeCondition` / `RegisterRoleTypeCondition` plus the in-memory visibility filter their
lookups apply.

- Signum DUPLICATES those methods per module, each closed over its own entity type. Every altea user asset
  carries the same `owner: Lite<Entity> | null`, so they live here ONCE and each module re-exports a thin
  wrapper under Signum's name. The `@quoted` predicate is written once and bound per entity type by the
  LINQ binder (the ctor is the registry key).
- `AssertImplementedBy(x => x.Owner, ownerType)` is dropped: an altea `@implementedBy` list is declared on
  the field itself, so there is nothing to assert at runtime.
- Signum ALSO mirrors each condition onto every child/part entity (`RegisterTypeConditionForPart<T>`,
  TokenEquivalenceGroup, …). altea needs none of it: a Part inherits its owner's TypeAllowed and
  TypeConditions structurally, chaining to the non-Part root, and TypeAuthLogic rebases the root's
  condition onto a standalone part query.
- the in-memory filter is `TypeAuthLogic.isAllowedFor`, which may need to fill DB-only conditions — so
  `filterVisible` is ASYNC where Signum's predicate was sync.
