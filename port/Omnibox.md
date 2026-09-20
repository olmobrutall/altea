# Signum.Omnibox → @altea/altea-omnibox

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Omnibox/`

The navbar's free-text command box: type `Order 5`, `Customer Name="Maria"` or `!SwitchUser` and get a
ranked list of things to jump to. `POST /api/omnibox` takes the raw text plus the special-action keys the
client has registered, and returns the suggestions.

## The parse is a TOKEN PATTERN, and that keeps the grammar declarative

The text is tokenized into a flat list, rendered as a compact pattern string — one char per token:
`I`=identifier, `N`=number, `S`=string, `E`=entity key, `G`=guid, `=`=comparer, any other symbol as itself
— and both are handed to every registered generator. A generator matches the pattern with its own regex:
`^I(N|G|S)?$` for `Order 5`, `^I(I(\.I)*(\.|(=[ENSIG]?))?)*$` for `Order Customer.Name="Maria"`.

- **Generators are ASYNC** (`getResults` returns a Promise), because every database call is. Signum's lazy
  `IEnumerable` + `.Take(MaxResults)` short-circuit therefore becomes an explicit slice.
- **There is no ambient state.** Signum threads the client's special-action list through an
  `AsyncThreadVariable` (`ReactSpecialOmniboxGenerator.OverrideClientGenerator`); altea passes an explicit
  per-request `OmniboxContext` to every generator. That is also why Signum's two special-action classes —
  a generic generator over a dictionary plus a thin wrapper swapping in a per-request one — collapse into
  ONE here, which builds its dictionary from `ctx.specialActions`.
- `CancellationToken` is dropped: the express handler has no equivalent, and the client aborts the fetch.

## The wire model is declared ONCE

Signum declares the results twice — as C# classes with JsonConverters (OmniboxParser.cs,
EntityOmniboxResultGenerator.cs, DynamicQueryOmniboxResultGenerator.cs,
SpecialOmniboxResultGenerator.cs) and again, by hand, as TS interfaces inside each `*OmniboxProvider.tsx`.
altea is one language, so `data/OmniboxResults.ts` is the single declaration in the isomorphic DATA layer:
the server generators build those shapes and the client providers render them. Field names and casing match
Signum's JSON exactly, so the ported providers read unchanged.

`resultTypeName` is the discriminator (Signum's `OmniboxResult.ResultTypeName => GetType().Name`), and the
client's provider registry is keyed by it.

**`QueryDescription` is gone**, so a dynamic-query result's `queryToken` is the token's fullKey STRING
where Signum ships a whole `QueryTokenTS` DTO and reads only `.fullKey` off it.

`OmniboxMatch` keeps only its wire half here: Signum's carries an `object Value` marked `[JsonIgnore]`, and
the server-only pairing lives in `OmniboxUtils` instead — so nothing has to be stripped before serialising.

## Authorization is resolved UP FRONT, because it is async

Signum filters inline with SYNCHRONOUS predicates — `Schema.Current.IsAllowed(type, inUserInterface: true)
== null`, `QueryLogic.Queries.QueryAllowed(qn, true)` — passed straight into `OmniboxUtils.Matches`. altea's
authorization reads a ResetLazy rule cache and is therefore async, while the MATCHER must stay synchronous
(it is a generator over a dictionary).

So each generator resolves the allowed SET in one pass over the candidate list and hands the matcher a plain
`Set.has` predicate. Same semantics, one await earlier.

Both helpers are PERMISSIVE when the auth module is not started (a host without authorization): the omnibox
then shows everything, exactly as an unsecured Signum app does. The special-action filter is unconditional
by design — Signum's `ReactSpecialOmniboxAction.Allowed` is hardcoded `() => true` with the comment
*"filtered client-side to avoid duplication, at the end the action itself is server-side checked"*, and the
same holds here.

## The permission needs no registration call

Importing the message/permission module evaluates its `init()` declaration, which registers
`OmniboxPermission.ViewOmnibox` in the declared-symbols set that `SymbolLogic.start(sb, PermissionSymbol)`
— already called by the auth module — seeds. So it lands in the table and is authorizable with no extra
`SymbolLogic.start` here, which would double-start.

Signum's `ReflectionServer.RegisterLike(typeof(OmniboxMessage), …)` — gating the message enum out of the
reflection blob for unauthorized users — has no counterpart: altea's message containers are plain objects
bundled with the client, not blob entries. The ROUTE is gated, which is what actually matters.

## A suggestion answers to its CODE name too

Signum matches every candidate on its localized nice name ALONE, which means an application translated
away from English has no way to reach a query by the name its own source calls it: in German, typing
`Order` returned nothing, because the query is shown as `Bestellung`.

So `OmniboxUtils.matches` takes an optional `codeName` selector, giving each entry a SECOND identifier
tried by the same three strategies. Every catalogue passes one: the query key and the clean type name
(`getKey` / `cleanTypeName`), a sub-token's `key`, and an enum member's name. This is what the
QueryTokenBuilder dropdown has always done — its filter hits either `t.key` or `t.toString()` — so the
two token pickers now answer to the same words.

The rules, where the two identifiers disagree:

- **The row still reads as the translated name.** The omnibox offers one vocabulary; only the DISTANCE
  comes from the code name, so a prefix hit on it still outranks a mid-string one.
- **ONE row per entry.** When both names match, the closer distance ranks the row but the nice match
  keeps the bold mask — those characters really are in the text being shown. A code-name-ONLY hit comes
  through unbolded, because nothing in that text was typed.
- **An exact code name is matched case-INSENSITIVELY**, unlike the nice name's map lookup, and a camelCase
  key has its first letter raised before the PascalCase subsequence walks it — `totalPrice` has no leading
  uppercase to consume otherwise, so `TP` would not reach it.
- **A whole code name counts as a fully-typed query name** in the dynamic-query generator, which offers a
  query's columns once its name is complete. That check compares the match TEXT with what was typed, and
  the text is the translated name, so the code name is compared separately.

## Smaller things

- `OmniboxUtils` is the fuzzy matcher, three strategies in order of preference: an exact key hit (distance
  0), a PascalCase subsequence (`OD` matches `OrderDate`, only when the pattern is all-uppercase), and a
  case-insensitive contains (each space-separated part must occur somewhere). A match carries a same-length
  `#`/`_` mask so the client can bold the hit characters. `toPascal`, `removeDiacritics` and `splitNoEmpty`
  live there because they come from Signum.Utilities' string extensions, which altea does not port.
- **C#'s duplicate capture group is illegal in JS.** The entity generator's `(?<id>N)|(?<id>G)` is merged
  into one `[NG]` class.
- The tokens barrel (`…/tokens`) is a DIRECTORY index and the package's `./*` export map resolves only
  files, so each token module is imported by its own path — as altea-chart and altea-user-assets do.
- The autocomplete is a Typeahead over one in-flight request (the previous aborted): Enter / click runs the
  result's navigateTo and pushes the URL, Tab replaces the input text with the result's canonical form
  (disambiguation), and `minLength 0` means an empty box already shows the syntax guide. Help rows are
  non-selectable, and the un-referenced ones act as section headers.
