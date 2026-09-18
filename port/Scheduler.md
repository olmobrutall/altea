# Signum.Scheduler → @altea/altea-scheduler

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Scheduler/`

A ScheduledTask pairs a TASK (what to run) with a RULE (when), and every run is logged. The runner is
IN-PROCESS: a queue of (scheduled task → next date) ordered by date, and ONE timer armed for the earliest of
them.

## The runner

- **`System.Threading.Timer` → `setTimeout`, and the `lock (priorityQueue)` disappears.** Node runs the
  callback on the single event loop, so the queue is only ever touched between awaits. What Signum's lock
  protected against — a reload racing the tick — is handled by re-reading the queue after each await.
- **`PriorityQueue<T>` → a plain array kept sorted by next date.** The queue holds one entry per ACTIVE
  scheduled task (tens, not thousands), so an O(n) insert is cheaper than a heap.
- **`Task.Run(...)` → an un-awaited async call whose rejection is LOGGED**, so an exploding task can never
  take the process down.
- **the planner warms the holiday cache before advancing any rule.** The schedule rules evaluate
  SYNCHRONOUSLY — they are isomorphic, and the editors preview them — but a weekday rule needs its holiday
  calendar, which lives behind an async cache. Warming it first is what lets the rules stay sync.
- `EntityCache(ForceNew)` has no counterpart (there is no identity-map scope beyond a retriever); each run
  already gets its own `Transaction.forceNew`, which is what mattered. `AuthLogic.Disable()` →
  `ExecutionMode.global`; `UserHolder.UserSession(user)` → `UserHolder.withUser`.
- Signum's controller sleeps a second after start/stop so the panel's immediate reload sees the new state;
  `startScheduledTasks` is async here and already awaited, so there is nothing to sleep for.
- Signum registers its shutdown hook on the host's `ApplicationStopping` token; altea's web host has no
  lifetime object, so it hooks the process signals (`stopAt`), which an app may also call directly.

## The registries

- **`Polymorphic<Func<ITaskEntity, ScheduledTaskContext, Lite<IEntity>?>> ExecuteTask`** → the
  `registerExecuteTask` registry, keyed by constructor and walking the prototype chain, so a handler
  registered for a base task type serves its subclasses — which is what `Polymorphic` gives.
- **the SimpleTask registry is keyed by the symbol's KEY, not by the symbol OBJECT.** A symbol read back
  from the database is a fresh instance, not the declared singleton, so an identity-keyed Map misses on
  every scheduled run — it only ever hits for a task executed straight from the declared symbol. (The same
  gotcha altea-processes and the operation registry record.)

## Entities

- `DateTime` → `Temporal.PlainDateTime` throughout. Signum's rules do their arithmetic in the server's
  local time; a PlainDateTime is exactly that — a wall-clock instant with no zone — so the port is literal,
  and `Clock.now` (altea's testable clock) replaces `Clock.Now`. `DateOnly` → `Temporal.PlainDate`.
- `IScheduleRuleEntity` / `ITaskEntity` are Signum interfaces over `IEntity`; altea has no `IEntity`, so
  they are TS interfaces extending the `Entity` CLASS (the shape `data/security.ts` uses for
  `IUserEntity`). `Clone()` is kept — the ScheduledTask editor clones a rule when switching type.
- `MList<HolidayEmbedded>` → a `@part` collection row, named by the `<Owner>_<field singular>` convention.
- **the cached `Lazy<HashSet<DateOnly>>` behind `IsHoliday`** is a per-instance Map built on first use; the
  entity is a plain field bag, so it is rebuilt whenever the instance is — which is what Signum's
  constructor-created Lazy effectively does too.
- **the holiday caches are ASYNC.** Signum caches `FrozenDictionary<Lite, Entity>` plus the default
  calendar in two GlobalLazys; altea's ResetLazy is async, so they are read with `await` and the rules read
  them through a SYNC resolver installed by `HolidayCalendarLogic` (see the runner note above).
- `ImportPublicHolidays` calls the same third-party service Signum uses (date.nager.at) through the global
  `fetch`; `GetCountries` / `GetSubDivisions` are ported alongside it for the editor's dropdowns.
- Signum's `SchedulerMessage` / `ScheduledTaskMessage` / `ITaskMessage` enums become message containers.

## The panel's wire shapes

Declared ONCE in the isomorphic layer, so the runner that fills them and the page that renders them share
one definition — the convention altea-omnibox established. **Dates are ISO STRINGS rather than Temporal
values**: this is a read-only snapshot for display, and the page formats them relative to now, which is the
same reason Signum's DTO uses `string ServerLocalTime`.

The health check is ANONYMOUS (a load balancer polls it), as in Signum; the other two panel calls assert
`ViewSchedulerPanel`.

## Log cleanup

`SchedulerLogic.start` registers this package's `ExceptionLogic.DeleteLogs` handler (exception LINES first,
then the logs no line points at), and `DeleteLogsTaskLogic` — OPT-IN, an app calls it next to
`SchedulerLogic.start` — is where the schedulable cleanup itself lives: `DeleteLogsTaskEntity` is an
`ITaskEntity` holding core's `DeleteLogParametersEmbedded`, so a ScheduledTask can point at it. It is here
rather than in core because the parameters need a persistent home and that home has to be an ITaskEntity,
which is this package's; core may not depend on the scheduler. See `port/TranslationGaps.md` item B3.

## Not ported

- **`IUserAssetEntity` (Guid + ToXml/FromXml)** on the rules and the holiday calendar: they would round-trip
  through @altea/altea-user-assets, which nothing in the scheduler needs yet. The `Guid` field and
  `UserAssetsImporter.Register` go with it.
- **`QueryLogic.Expressions.Register` for Executions / LastExecution / ExceptionLines**: those are `@quoted`
  expression MEMBERS in altea, and putting them on the entities would make the isomorphic data layer import
  the server query API. The panel reaches the same rows through explicit filters instead.
- **`SimpleTaskLogic`'s `PreDeleteSqlSync`** — the sync script that deletes a retired symbol's tasks and
  logs before dropping the row — needs `Administrator.DeleteWhereScript`, which altea does not have. A
  symbol removed from the code therefore surfaces as a foreign-key conflict in the sync script rather than
  as generated cleanup SQL.
- `SystemEventLogLogic.Log(...)` for the runner's start/stop — reported through the panel's state instead.
- The ChangeLog module, `CopyHealthCheckButton`, and the `ScheduledTaskLogDatesDTO` bar-chart column
  formatter (which needs `buildDateScale` from Signum's D3Utils). `Constructor.registerConstructor` for
  pre-filling a new weekday rule's default holiday calendar goes with the last: pick it in the editor.
- The panel's "available tasks" section (one SearchValueLine per implementation of `ScheduledTask.task`):
  the task implementations are an app-level `@implementedBy` override, and the ScheduledTask search below
  already shows what is scheduled.
