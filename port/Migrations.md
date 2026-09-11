# Signum.Migrations → @altea/altea-migrations

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Migrations/`

Versioned `.sql` files on disk plus a list of named code steps, each recorded once it has run so it never
runs twice across deploys. Three System/Transactional tables, all with no Ticks — history rows nobody
concurrently edits.

## The two runners

- **The C# names are gone from the code, and kept for a Signum database.** `CSharpMigrationRunner` is
  `TypeScriptMigrationRunner`, `CSharpMigrationEntity` is `TypeScriptMigrationEntity`, and the message it
  prints reads "Reading TypeScript migrations" — the steps a runner runs here are TypeScript, and an
  application should not be told otherwise. What a SIGNUM database calls them survives in LEGACY MODE,
  from ONE declaration: `@legacyClassName("CSharpMigrationEntity")` names the class `basics.type.className`
  holds — the column a Signum application synchronizes back to its own answer — and the CLEAN name
  (`basics.type.clean_name`, the query key, the `$type` discriminator) and the TABLE both follow from it by
  the ordinary rules. Every `@legacy*` name is read only while legacy mode is on, so a fresh altea database
  carries no C# name at all.
- **An EXISTING altea database sees a rename**, offered as one by `terminal sync` (the table) and by
  `synchronizeTypes` (the `basics.type` row). Accepting both keeps every recorded step; answering "no"
  re-runs every migration on the next `ts`.
- **`Action` + `action.Method.Name` becomes `add(uniqueName, action)`, name FIRST.** A TS function's `.name`
  is unreliable (arrows, minification), and that name is the migration's IDENTITY in the database —
  renaming one re-runs it, exactly as in Signum. Signum's `IEnumerable<MigrationInfo>` + collection
  initialiser becomes plain `add` calls.
- **the retry PROTOCOL is not ported, but its marker is.** Signum offers "open the failing script in an
  editor, retry, abort"; here `execute` reports the failure and rethrows it as an
  `ExecuteSqlScriptException` (declared in core, where Signum declares it), and `prompt` catches that type
  — interactively it redraws the list and asks again, an autoRun deploy rethrows. **Without the marker the
  terminal's top-level handler printed every failed step a SECOND time.**
- **`SqlPreCommand.HasNoTransaction` / `ExtractNoTransaction` have no counterpart**, so a script is written
  as ONE file where Signum splits it into up to three around its no-transaction parts. The `NT_` comment
  prefix is still honoured on the way IN: a file whose comment starts with `NT_` runs OUTSIDE a
  transaction, which is how a hand-written `CREATE INDEX CONCURRENTLY` / `ALTER TYPE` migration is applied.
- **`#DatabaseName#` is not ported.** Signum replaced it so a script could name its own database
  (cross-database references); altea's schema has no database-qualified names to rewrite, so a script
  carrying the token cannot be executed faithfully — `execute` says
  so rather than running something that means a different thing. The constant is kept (unused) so a
  Signum-authored script containing it still round-trips.
- **`ResetCache` → `Schema.current.initialize()`**, altea's post-DDL refresh (it re-reads the TypeEntity and
  symbol caches). Signum additionally resets every GlobalLazy, which altea does through the same call.
- **`SquashMigrationHistory` checks once, not in a loop.** Signum loops the total-synchronize until it is
  empty; altea's `synchronizationScript` is already complete, so a single pass suffices and any remaining
  script is shown.
- **every prompt is async** (node readline), so the whole loop is async top to bottom.
- Signum ignores database rows OLDER than the first file on disk (a squashed history). Kept.

## MigrationLogic

- **`Administrator.AvoidSimpleSynchronize` has no counterpart.** Signum sets it so a plain `sync` on a
  migration-managed database offers to create a migration instead; here the APP's terminal decides (see
  eastwind's `synchronize`, which asks `MigrationLogic.hasSqlMigrations` first) — one less global mutable
  seam, same behaviour.
- **`ExecuteLoadProcess` RETURNS the caught error** (Signum returns `Exception?`), so a caller can decide
  whether the remaining steps still run. The console output is the same banner + timing.
- **`ensureMigrationTable` also creates the SCHEMA** when the table lives outside the default one, as
  Signum does; `createSchema` is idempotent-guarded by the dialect builder, so emitting it is safe.
- `ExceptionLogic.DeleteLogs` purging old LoadMethodLog rows is deferred WITH altea's DeleteLogs
  machinery — the note every log-owning module carries.
- **`Duration` is an in-memory helper, not a query column.** Signum declares it `[ExpressionField]`;
  @altea/altea-processes and @altea/altea-scheduler make the same call for their own log durations, and
  the value is only ever read off a loaded row while a stored `start`/`end` pair is what a query filters on.
- `DateTime` → `Temporal.PlainDateTime` (the terminal's wall clock, like the scheduler's rules).

## The client half exists only in altea

Signum has no `MigrationsClient.tsx`: its three tables are reachable because the auto-generated
`Signum.Migrations.ts` registers their Types, and their COLUMNS come from the server's
`WithQuery(() => e => new { e.Id, e.VersionNumber, … })` projection.

altea has neither half of that — a type is only known to the client once `cb.configure` names it, and
`withQuery()` takes no projection, so default columns are a CLIENT setting. The module therefore carries
exactly what Signum's three WithQuery projections said, and registering it is also what makes
`/find/SqlMigration` & co. work at all.

No views: Signum ships none for these types either (there is no Templates folder in Signum.Migrations), so
altea auto-generates one from the property routes. History rows are read, not edited.

## Messages

Only the strings the runners actually print are declared. Signum's own prompts are hard-coded English
inside `SafeConsole` calls, so the console UI of both runners is otherwise plain.

`SafeConsole` itself moved to `@altea/altea` (`server/safeConsole`) when core's own sync flow needed it,
and is re-exported here unchanged.
