# Signum.WhatsNew → @altea/altea-whats-new

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.WhatsNew/`

In-app RELEASE NOTES. An administrator writes a news item (one message per culture, a preview picture,
attachments), publishes it, and every user sees it once in the navbar bullhorn; opening it records that
they have read it.

Not to be confused with the CHANGE LOG, which is the developers' list compiled into the client.

## The news are NOT cached, and that is what makes them safe

Signum keeps a `GlobalLazy` of every WhatsNew and then re-applies row security to the cached list with
`Schema.GetInMemoryFilter<T>(userInterface: false)`. altea's `globalLazy` is async, and — more to the point
— it has no in-memory twin of a TypeCondition filter (an app must register one explicitly; see eastwind's
user-asset scoping). Querying the table instead gets the row filter for free, applied by the LINQ binder
exactly as for any other query, and the table is tiny by nature: one row per release.

Same reasoning retires `Administrator.QueryDisableAssertAllowed<WhatsNewLogEntity>()` inside `IsRead`:
altea's row filter is SPLICED by the binder onto every query of a type and cannot be suppressed for one
subquery. The expression reads the log directly, which is equivalent unless an app puts a TypeCondition on
WhatsNewLog — and one there would mean "you may not see your own read marks".

## Divergences

- **the two `MList`s become `@part` ROWS.** The message row keeps Signum's `WhatsNewMessageEntity` NAME;
  the attachment row has no Signum name of its own — its element is a bare `FilePathEmbedded`, so it
  becomes `WhatsNewEntity_Attachment` holding one. `Attachment` is renamed **`attachments`**: it is a
  COLLECTION, and every other one in the port is plural. The ported translation XMLs carry the renamed
  member.
- **`[DefaultFileType(...)]` has no counterpart**, so the two FileLines name the file type directly and the
  image handler states its own size limit (4 MB) — the accommodation @altea/altea-help's image handler
  documents.
- **`Schema.ForceCultureInfo` has no counterpart**, so the culture a news item MUST have a message for is a
  settable `WhatsNewLogic.defaultCulture`, defaulting to `"en"` — which is what Signum falls back to when
  ForceCultureInfo is unset.
- **the static property validation is pushed onto the route's FieldInfo**, altea's counterpart of a
  validation added from outside the declaring class (the call @altea/altea-isolation makes for its required
  field). Signum writes `Validator.PropertyValidator(wn => wn.Messages).StaticPropertyValidation`.
- `[CountIsValidator(GreaterThan, 0)]` → `@countIsValidator(ComparisonType.GreaterThan, 0)`, which altea
  reads as "this collection is mandatory" in the UI.
- **`WithCascadeDeleteBy` / `WithExpressionFrom`** are Signum fluent-include steps altea does not have: the
  cascade is `withCascadeDelete` on the log's back reference, and the expression is registered directly.
- **`setNewsLog` inserts row by row** instead of Signum's set-based `UnsafeInsert`: its projection
  (`wn => new WhatsNewLogEntity { … UserEntity.Current … }`) reads the current user inside a query lambda,
  which has no SQL translation in altea. The set is at most a handful of lites — "the toasts I just closed"
  — so the loop is cheaper than the machinery to avoid it. It runs in `ExecutionMode.global`, as Signum's
  `AuthLogic.Disable()` does: a user must be able to record having read something whatever their rules on
  the log table say.
- **the preview-picture route stays AUTHENTICATED**, where Signum marks it `[SignumAllowAnonymous]`. The
  picture belongs to a news item whose visibility is exactly what this module computes, so serving it to
  anyone would hand out the one part of an unpublished item that has no other gate. The same call
  @altea/altea-mailing-microsoft-graph's attachment download made.
- **the two `[AutoExpressionField]` extension methods become `withQuoted` PROTOTYPE members** (the idiom
  @altea/altea-view-log uses), server-only because both bodies are queries. `isRead`'s declared return type
  is a PROMISE because `some` is a query terminal, exactly as @altea/altea-workflow's
  `currentUserHasNotification` declares it; as a query TOKEN it is a plain boolean column.
- **a `Related` whose type has no registered config THROWS**, as Signum's `GetOrThrow` does: silently
  hiding or silently showing would both be wrong.
- `Navigator.addSettings(new EntitySettings(T, view, { modalSize: "xl" }))` → `cb.configure(T).withView(…)`;
  altea's EntityClientBuilder has no `modalSize`, and the news item is edited on its own page anyway.
- **the implementations of `related` are read STRUCTURALLY** off the TypeReference, where Signum splits a
  `", "`-joined clean-name list with `getTypeInfos(pr.type)`.
- luxon's `DateTime.fromISO(x).toRelative()` becomes `Intl.RelativeTimeFormat` over a Temporal difference,
  the same helper @altea/altea-alert's bell uses; `react-router-dom` → `react-router`;
  `@framework/Globals` → `@altea/altea/data/globals`; `Type.niceCount(n)` has no counterpart, so the
  button's tooltip is the plural type name.
- `ctx.memberInfo(wn => wn.related)` → `ctx.memberInfo("related")`: the quote-transformer does not rewrite
  lambdas in JSX ATTRIBUTES, and the string form is used for consistency with the rest of the repo.

## The wire DTOs

Declared in the DATA layer, so the routes and the client agree on one definition — the call
@altea/altea-omnibox made. Signum's live as nested classes on its controller and are duplicated by hand in
its client namespace.

**Both DTOs type their date as an ISO STRING**, exactly as Signum's generated `string /*DateTime*/` does,
and for the same reason: a DTO is not an entity, so nothing revives a Temporal value inside it — the
serializer only does that for reflected fields. Typing it `Temporal.PlainDateTime` compiles and then fails
at runtime on the first `.since(…)`. An ISO string also sorts correctly lexicographically, which is what
the two client sorts rely on.

## Signum bugs fixed rather than mirrored

- **the unread count is decremented by the number of items actually closed**, not by 1: Signum's optimistic
  update subtracts one even from "Close all", so the badge was wrong until the refetch landed.
- **`Navigator.raiseEntityChanged(SomeType)` notified nobody** — a core bug this module found. A `Type<T>`
  is a constructor in altea and `.toString()` is its source text, never the clean name `useEntityChanged`
  registered under. (Signum's argument is a string, so its `.toString()` is right.)

## Not ported

Three Signum pieces that are dead there: the changelog module registration and its two-line `Changelog.ts`,
`WhatsNewToast.icons` (declared, assigned an empty object, never indexed), and the two placeholder helpers
`replacePlaceHolders` / `getPropertyValue` declared inside `start` and never called.
