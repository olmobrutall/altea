# Signum.Mailing.MicrosoftGraph → @altea/altea-mailing-microsoft-graph

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Mailing.MicrosoftGraph/`

Two halves: SENDING through the Graph `sendMail` endpoint (one more implementation of altea-email's
abstract `EmailServiceEntity`), and the REMOTE MAILBOX — browsing a user's actual Outlook mailbox from
inside the app. They register separately (`RemoteEmailsClient.start(cb)`), matching the server split.

`Microsoft.Graph` becomes plain REST through the helper @altea/altea-auth-azuread already owns.

## The sender

The interesting field is `useActiveDirectoryConfiguration`: with it set, the service borrows the
application's EXISTING Entra ID registration (@altea/altea-auth-azuread's AzureADConfiguration) instead of
carrying its own client secret — which is what an app that already signs users in through Entra wants.
Signum's `PropertyValidation` makes the three Azure fields mandatory only when it is NOT set; three
`@validate`s say the same thing, since there is no PropertyValidation switchboard.

**`Azure_ClientSecret` is stored ENCRYPTED** (`EmailSenderConfigurationLogic.encryptPassword`) and edited
through a `newAzure_ClientSecret` field, which is what altea's own SMTP service does. **Signum stores it in
the clear**: it declares no `[Format(Password)]` and no JSON converter for this type, so the value
round-trips to the browser on every read. That is worth diverging from — it is a tenant-wide application
credential.

`[Description("Azure Application (client) ID")]` becomes `@niceName(...)`; `Guid?` becomes `uuid | null`.

## The remote mailbox is addressed by USER, not by mailbox id

Signum's RemoteEmails routes take the directory object id (`{oid}`) and the client reads it off
`UserLiteModel.ExternalId`. altea has no lite model, so **the routes take the USER's primary key and
resolve the mailbox server-side** — which also means a caller cannot read an arbitrary mailbox by naming
its oid, and it removes Signum's four "User has no OID" throws.

## Inline images: the route stays AUTHENTICATED

Signum rewrites each `cid:` reference to the attachment route's URL and lets the browser fetch it, which
needs that route to be ANONYMOUS. altea authenticates with a Bearer token, which an `<img src>` cannot
carry — so the bytes are fetched through the app's own ajax and turned into blob URLs (the same thing
altea-files' `FileImage` does), and the route stays authenticated.

## One model becomes TWO

Signum's single `RemoteEmailMessageModel` serves both roles: the query row AND the opened message. They
carry different fields — a row has a `toRecipients` STRING and no body; the opened message has the full
recipient lists, the body and the attachments — and, decisively, **a query row model must not have a member
called `id`**, because a member of that name is excluded from the token tree.

So: `RemoteEmailMessageRowModel` (the query) and `RemoteEmailMessageModel` (the message view, which keeps
`id` because it is never a query row).

The query is named by its ROW MODEL rather than by an enum member, and each column's caption is the field's
own `@niceName` — there is no QueryDescription to hang a projection on. The same treatment
altea-auth-azuread's `ActiveDirectoryUsersRowModel` gets.

## Other divergences

- `PreSaving` / `PostRetrieving` throwing "RemoteEmails can not be saved" has no counterpart on a
  ModelEntity: altea models are not saved or retrieved through the ORM at all — there is no table.
- `DateTimeOffset` → `Temporal.PlainDateTime`. Graph returns UTC ISO strings, which the server converts
  once.
- `MList<string> Categories` → a plain `string[]`: this is a MODEL, so there is no table. Signum shows them
  in a `<MultiValueLine/>`; altea's takes `R extends BaseEntity` (its scalar-collection line is not
  ported), and the view is read-only anyway, so they render as plain text under the field's own label.
- **`FilesClient.extensionInfo[…]`** (an icon + colour per file extension) is not part of altea's files
  port, so an attachment gets one generic file icon. Noted rather than reinvented.
- **`MultiMessageProgressModal` is its own component**, not altea's `MultiOperationProgressModal`: that one
  keys its results by `lite.key()`, and a remote message has no lite. It is Signum's own
  MultiOperationProgressModal with "a Lite and an operation" swapped for "a message id and a title", fed by
  the route's NDJSON stream.
- **the folder filter's effect is kept as-is**: a folder that arrived from a URL carries its own id as its
  displayName, so once the real folder list lands the name is filled in — and a folder that is NOT in the
  list at all is CLEARED, because it belongs to another mailbox.
- `ContextualMenuItem` is a React element here (Signum wraps it in `{ fullText, menu }`).
- `ChangeLogClient.registerChangeLogModule` has no counterpart (its `Changelog.ts` was an empty stub).

## Not ported

**TNEF (`winmail.dat`) unpacking** on reception, shared with @altea/altea-mailing-pop3.

## The two vocabularies, and the suite that pins them

A query **TOKEN** key is PascalCase (`EntityPropertyToken.key` is `fieldInfo.name.firstUpper()`); a
Microsoft **GRAPH** field is camelCase (`subject`, `receivedDateTime`, `parentFolderId`). `toGraphField` is
the crossing, and it lowers each key — Signum's own `a.Key.FirstLower()`, a line this port had dropped back
when altea's token key was the camelCase field name verbatim and lowering was a no-op.

Every string in the converter therefore belongs to one side or the other: **compare against a TOKEN key in
PascalCase, and write or match a GRAPH field in camelCase.** The Graph-side ones (`fieldAliases`, the
`onPremisesExtensionAttributes` collapse) are applied AFTER the lowering, so they stay camelCase.

`RecipientEmbedded`'s two members are the exception that is neither: they are identified by the MEMBER, as
Signum identifies them (`ReflectionTools.PropertyEquals(ept.PropertyInfo, piEmailAddress)`), and each
contributes a two-segment Graph path — `emailAddress/address`, `emailAddress/name`. This port had matched
the assembled string instead (`.replace(/\/name$/, …)`), which is right for this row model only because
nothing else in it has a member called `name` — a fact about today's model rather than about the rule. The
selectors go through `memberPath`, so they are compiler-checked and follow a rename.

**None of that is altea's invention — it is Signum's, and this module had drifted off it.** Signum's own
comparisons are PascalCase throughout (`"User"`, `"Id"`, `"Entity"`, `"Folder"`, `"Extension"`), and this
module now matches them literal for literal. While altea's token keys were camelCase the porter lower-cased
each of them, correctly for that convention; the convention moved back and these sites did not.

The one mapping that IS altea's: `MessageId → id` (and `objectId → id` in the base). Signum's row models
call the member `Id`, so `FirstLower` yields Graph's `id` for free — altea's cannot, a member named `id`
being excluded from a query's token tree, so the rename is undone explicitly.

`test/graphFields.test.ts` pins the resulting field names against the documented resource fields, for this
converter and the `altea-auth-azuread` base it extends. DB-free, because `toGraphField` is pure given a
token — which is worth knowing, since the `$select` / `$filter` / `$orderby` strings otherwise fail against
the live API as an opaque 400 and a tenant looks like the only way to check them. See
[OpenQuestions.md](OpenQuestions.md) §2.4 for what that repair covered.
