# Signum.SMS → @altea/altea-sms

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.SMS/`

A TEMPLATE (per-culture text authored against a query and/or a code-declared model), a MESSAGE, two
PACKAGES a batch process walks, and a PROVIDER seam.

Structurally a small sibling of @altea/altea-email, which ports the same template + model-registry +
message shape — and almost every decision here is inherited from it: `MList` → `@part` rows, the model
registry keyed by CLEAN TYPE NAME and maintained through `Schema.Generating` / `Schema.Synchronizing` (so a
renamed model class keeps its row, and the FK every template holds), the `SMSModel<T>` abstract base
class kept as one (the class is the registry key), and the query executed through
`QueryLogic.queries.executeQueryAsync` with hand-built Columns / Filters / Orders because there is no
QueryDescription to thread.

## `SMSCharacters` is the one piece worth its own suite

`test/smsCharacters.test.ts`, 13 cases. The GSM 03.38 rules are not intuitive — 160 basic characters, seven
of them escaped and costing two, and **ONE character outside the alphabet re-prices the WHOLE message as
UCS-2** — and a wrong answer silently TRUNCATES a message (`messageLengthExceeded: TextPruning` cuts to
whatever it returns).

Two divergences:

- the tables are SETS of code points, where Signum maps each character to its own code point and only ever
  tests presence;
- **the UCS-2 budget is 70, not Signum's `maxLength = 60`**, which is neither the single-part nor the
  concatenated figure.

Counting iterates by CODE POINT, so an emoji costs one unit and correctly forces UCS-2, and the truncation
uses `[...]` so a surrogate pair is never cut in half (Signum's `RemoveEnd` counts UTF-16 units).

## `SMSOwnerData` is an interface, and the object projection LOWERS TO SQL

Signum makes it a `DescriptionOptions` POCO that a query column can project. altea needs no reflected type,
because a `@quoted` member returning a hand-built object
(`{ owner: this.toLite(), telephoneNumber: this.phone, culture: null }`) **is a real query token** —
verified on eastwind's `CustomerEntity.smsOwnerData()`. That is what a template's `to` points at.

It still has to be REGISTERED as an expression (`@quoted` alone is not a token) — ONCE, on the abstract
base, since `getExtensionsTokens` walks the parent token's own prototype chain and every concrete subclass
finds it there. Its `Equals`-based de-duplication becomes `distinctBy(owner key)`.

## Divergences

- **a message's culture is a `Lite<CultureInfoEntity>`**, matching altea-email's template messages: altea
  DOES have a CultureInfoEntity table, so the reference is a real FK rather than Signum's owned
  CultureInfoEntity reference. The member is `cultureInfo`, as Signum names it.
- **`MultipleTelephoneValidator` has no counterpart** (core has `telephoneValidator`, single-number only),
  so the comma-separated form is a `@validate` — the same rule, spelled out. `DateTimePrecisionValidator`
  DOES have one now (core's `@dateTimePrecisionValidator`, TranslationGaps B4), so `sendDate` carries it
  again; the truncation where the value is ASSIGNED stays, as what satisfies it.
- **`SendAsyncSMS` is dropped** (Signum's detached `Task.Factory.StartNew`): a floating promise in Node is
  an unhandled rejection waiting to happen and races process exit — the Send PROCESS is what
  fire-and-forget means here. The same call altea-view-log made for its log write.
- **the two ConstructFromMany operations THROW where Signum returns null.** altea's `construct` must return
  an entity, so "nothing to package" says so instead of silently answering nothing.
- **`registerSMSOwnerData` is registered ONCE for a hierarchy**, on the abstract base — an operation is
  keyed by its symbol and a subclass inherits its base's. Signum registers per concrete type only because
  C# generics force `Graph<ProcessEntity>.ConstructFromMany<T>` to name one. The projector also retrieves
  through the LITE's own concrete type, since an abstract base has no table.
- **the messages repeater renders even WITHOUT a query**, where Signum gates it on `ctx.value.query`: a
  query-less template is a legitimate shape here too — `SMSLogic.createSMSMessage` has a whole branch for
  it (a per-culture text with no replacements) — and Signum's gate leaves such a template un-editable.
- `registerToString(SMSTemplateMessageEmbedded, …)` has no counterpart: the row IS an entity here and
  carries its own `toString()`. `EntityTabRepeater` binds `@part` ROWS, so each tab's ctx is the row entity.
- the query settings' default columns are registered on the CLIENT, which Signum gets from its server-side
  `WithQuery` projection.
- a message renders in the scope of its owner's isolation, Signum's
  `using (ExecutionMode.SetIsolation(smsModel.UntypedEntity))`.

## Not ported

- both `ExceptionLogic.DeleteLogs` handlers.
- `SMSModelEntity`'s `[TicksColumn(false)]` — no such option, and the row is only ever written by the
  synchronizer.
- the `Retrieved` / `AfterDeserialization` token re-parse (altea resolves tokens client-side).
- the two package queries' `NumLines` / `LastProcess` / `NumErrors` columns — altea-processes exposes
  neither `LastProcess()` nor `ExceptionLines()` as an expression, so each package's VIEW shows its
  messages in a SearchControl instead.

## What it surfaced in eastwind

**The three background runners had never been started.** Southwind's `Program.cs` starts `ProcessRunner` /
`ScheduleTaskRunner` / `AsyncEmailSender` 5 s after boot behind a `StartBackgroundProcesses` flag; eastwind
imported `ScheduleTaskRunner` and never called it, so a scheduled task, a queued process and an async
e-mail were all created and never run. Started now, web-host only — a terminal run must not pick work up.
