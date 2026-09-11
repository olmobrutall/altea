# Signum.Templating → @altea/altea-templating

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Templating/`

The TEXT-TEMPLATE engine every report kind shares: a template is text with `@[token]`, `@if[…]`,
`@foreach[…]` markers, resolved against a QUERY (the row set) and/or a MODEL (an in-memory object).
@altea/altea-email, @altea/altea-sms and @altea/altea-office-template are the consumers.

The parser, the value providers and the renderer are server-only; `data/Templating.ts` holds only what
both tiers need.

## What a bracket can name

```
@[Customer.Name]     the QUERY (implicit)   → TokenValueProvider
@[q:Customer.Name]   the QUERY (explicit)   → TokenValueProvider
@[m:ShortAddress]    the MODEL              → ModelValueProvider
@[g:Now]             a GLOBAL variable      → GlobalValueProvider
@[n:Order.State]     a NICE NAME            → NiceNameValueProvider
@[d:…]               a DATE expression      → DateValueProvider
@[$line.Product]     a $variable's member   → ContinueValueProvider
@[42] / @["x"]       a constant             → ConstantValueProvider
```

- **`QueryDescription` is GONE**, so a parser carries the QUERY NAME and `ParsedToken` resolves through
  `QueryLogic.getToken`. That resolution is CASE-SENSITIVE — it walks reflected member names — so a
  stored token must match exactly.
- **`CollectionNestedToken` has no counterpart**, so a QueryContext is FLAT: one ResultTable, no
  `SubQueryContext` map. `@foreach` over an `…Element` token works the same; nested sub-queries are simply
  not expressible.
- **`QueryTokenOrRowId` has no counterpart yet.** Signum groups a `@foreach` by the MList row's RowId, so
  two rows with equal values stay distinct; here the foreach groups by the token's own VALUE, which is
  what Signum does for every non-MList collection. (`MListElementPropertyToken` is a token-layer TODO.)
- `@[m:A.B(C)]` walks a member chain: each step is a property / field / method name, a method is called
  with its arguments followed by the TemplateParameters (so a model can format with the culture), and the
  walk stops at the first null.
- A `…ToArray` token yields the whole collection and is joined the way `CollectionToArrayToken` does.
- Signum's `Reflector.FormatString(type)` becomes the field's own `@format`, read off the TypeReference
  when there is one. Numeric formats are the subset altea's own UI supports — `N<digits>` and friends —
  rather than the whole .NET vocabulary.

### `@[t:…]` is not ported, and the recorded reason has changed

`TranslateInstanceValueProvider` reports an error at parse time rather than silently falling back. The
source used to say it needed "Signum's PropertyRouteTranslationLogic, which altea has no counterpart for";
that is no longer true — `altea/server/propertyRouteTranslation.ts` landed with altea-translations. What
is left is this module's own half: a value provider that resolves a route's translated value per instance.
Until it lands, the parse error is the honest answer.

## The scan is BY HAND, because JS has no balancing groups

Signum's `KeywordsRegex` matches `@keyword[expr] as $var` with the `expr` group balancing nested brackets
through a .NET balancing-group construct. JS has nothing equivalent, so the regex here matches only the
keyword HEAD and the bracket body is scanned by `scanKeywords`. Same grammar; an unbalanced bracket falls
through to literal text, which is what Signum's non-matching regex also produces.

`raw` / `global` / `model` / `modelraw` / `declare` / `if` / `elseif` / `foreach` / `any` plus the EMPTY
keyword (a plain `@[…]` value) all open a bracket; the rest are bare closers.

The same reason drives the omnibox's hand-scanner — see [Omnibox.md](Omnibox.md).

## Conditions

The boolean expression inside an `@if[…]` / `@any[…]` bracket: `A && B`, `A || B`, `Token op Value`, or a
bare truthiness test. AND / OR bind left-to-right exactly as Signum splits them, OR outermost.

`GetResultFilter` returns a compiled LINQ predicate over a ResultRow in Signum; here it is a plain closure
over an in-memory comparison (`TemplateUtils.compareInMemory`) — same behaviour, no expression trees.

`@any[…]` asks "is there at least ONE?", so its provider must yield a COLLECTION, and that is enforced
rather than left to the caller.

## Nodes and rendering

`TextTemplateParser.Nodes.ts` is a C# nested partial class in Signum; TypeScript has no partial classes,
so the nodes are their own module and the parser imports them.

- `HtmlString` — ASP.NET's "already-encoded" marker, which suppressed escaping for one value — has no
  counterpart. Use `@raw[…]` to opt a value out of escaping.
- `HttpUtility.HtmlEncode` becomes a small local `htmlEncode`.
- `SemiStructuralEqualityComparer` (what decides whether two rows carry the SAME value for a column)
  walks a value's own enumerable properties rather than C# FIELDS, and treats Temporal / Decimal / Lite /
  Entity as "simple" — compared by their canonical string or id.

## The sync pass over a template's BODY TEXT

`server/TemplateSync.ts` is Signum's `TemplateSynchronizationContext` / `TemplateSyncException`: the
interactive pass that rewrites the tokens INSIDE a template's text when a query token is renamed. Every
value provider, node and condition carries a `synchronize`, and `TextTemplateParser.synchronize` is the
entry point; @altea/altea-email drives it over each message's Subject and Text with ONE context per
template. This is where @altea/altea-user-assets' `Member` and `Global` rename buckets are used — see
[UserAssets.md](UserAssets.md).

**The walk mirrors `write`** — same order, same variable scoping — because `write` is what turns the tree
back into the stored text: a node that synchronised under a different scope than it prints under would
rewrite a `$var` into one that is not in scope there.

Divergences: there is no QueryDescription (a token is fixed against the QUERY NAME, and `queryName ===
undefined` is what model-only means); no `forceChange`, altea discovering staleness by whether a token
resolves; the MEMBER bucket offers candidates only for a REFLECTED type, a step whose owner is not
reflected being accepted unchanged rather than renamed against invented candidates.

**One thing Signum does not do:** `synchronize` self-checks before touching anything — it prints the freshly
parsed tree and refuses, loudly, if it does not match the text it came from. A token that fails to RESOLVE
is a non-fatal parse error and leaves the tree complete (the state this pass repairs), but a FATAL one
aborts the parse and leaves a tree that is a PREFIX of the template; writing that back would truncate
somebody's template rather than repair it. `test/templateRoundTrip.test.ts` pins that, and the parse →
`write` round trip it rests on.

**Office documents go through the same context over a DIFFERENT tree** — an office template's tokens live
in the .docx/.pptx/.xlsx bytes, so @altea/altea-office-template gives each of its own nodes a
`synchronize` and walks them from `OfficeTemplateTokenSync`. See
[OfficeTemplate.md](OfficeTemplate.md).

One fidelity fix went back into the text nodes when the office half was written: a block keyword takes TWO
scopes, as Signum's does, and altea's text nodes had only the inner one. The outer scope holds the
KEYWORD's own provider — `@foreach[$d.Details] as $e` is a ContinueValueProvider whose `synchronize`
DECLARES `$e`, and `write` has no counterpart of that declaration, so without it `$e` stayed visible past
the `@endforeach`.

## Smaller divergences

- **The converter registry is keyed by the symbol's KEY, not the symbol OBJECT**: a symbol read back from
  the database is a fresh instance, not the declared singleton. The same gotcha altea-scheduler,
  altea-processes and the core operation registry each hit.
- `TypeHelpLogic.Start(sb)` — the C#-source type browser beside the Eval editor — is not ported: the
  honest equivalent is editor IntelliSense over the same `.d.ts` the eval compiler checks against.
- `TemplateApplicableEval` works exactly as Signum's — a script stored on the template, compiled on first
  use — except the script is TYPESCRIPT and the compiler is @altea/altea-eval's rather than Roslyn's. The
  parameter is typed from the owning template's QUERY (its single entity implementation), which is why
  the eval reads its owner.
- `QueryModel` keeps Signum's shape, but `queryKey` is a plain string (there is no `object QueryName`
  boxing) and its filters / orders / pagination are the isomorphic request DTOs — so the client's
  SearchControl can fill them and the server can run them unchanged.
- **The global-variables response carries the type NAME + isCollection**, not a `TypeReferenceTS` DTO: the
  editor only needs to know whether a variable is insertable and whether it is a collection.
  `ReflectionServer.RegisterLike(typeof(TemplateTokenMessage), …)` — which gated that message enum's
  translations behind "may this role see email templates" — has no counterpart, because altea ships ONE
  global reflection blob at boot; the `TemplateTokenMessageAllowed` callback list goes with it.
- **`TemplatingClient` is new.** Signum has none: its two views are registered by whichever module consumed
  them (MailingClient). Here the module owns its own registrations, so a consumer calls
  `TemplatingClient.start(cb)` and nothing else.
- The insert-snippet toolbar hands the snippet to the user through a `MessageModal` (pre-selected, in a
  `<code>` block) rather than Signum's `AutoLineModal`, which altea does not have — the same "Ctrl+C, ESC"
  flow.
