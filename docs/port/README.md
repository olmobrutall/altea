# Port ledgers

One page per module: what the Signum original does, what altea does instead, and why.

## What belongs here

The port narrative — "Signum does X, altea does Y, because Z". It documents the relationship between two
codebases rather than this code: a different audience (whoever re-applies a future Signum change, or lines
a database up with a Signum deployment), a different lifetime (it goes stale when *Signum* moves, not when
altea does), and it is read once per module rather than at every edit.

## What stays in the source

Anything that binds at the point of edit. The test:

> **Would this comment still be true and useful if `old/` were deleted?**

Yes → it is about altea. Keep it inline, in one to three lines. No → it is ledger.

So `RestLogFilter.ts` keeps "mount this AFTER `AuthLogic.start` — `UserHolder.current()` is read here" and
sheds the MVC-action-filter narrative. `MarkdownToPlainText.ts` keeps "DELIBERATELY INCOMPLETE: a code block
contributes nothing" — which a reader would otherwise take for a bug — and sheds the Markdig-to-mdast
correspondence table.

Each source file keeps one pointer line naming its C# original and the page here.

**A rule that is only true in legacy mode is a different case**: there, Signum's behaviour IS the
specification, so it stays inline. See [LegacyMode.md](LegacyMode.md), which inventories those.

## Pages

| Page | Module |
| --- | --- |
| [ConcurrentUser.md](ConcurrentUser.md) | `@altea/altea-concurrent-user` |
| [DiffLog.md](DiffLog.md) | `@altea/altea-diff-log` |
| [Eval.md](Eval.md) | `@altea/altea-eval` |
| [FileStores.md](FileStores.md) | `@altea/altea-files-azure`, `@altea/altea-files-s3` |
| [Isolation.md](Isolation.md) | `@altea/altea-isolation` |
| [LegacyMode.md](LegacyMode.md) | *cross-cutting* — `SchemaSettings.legacyMode` |
| [MailingExchange.md](MailingExchange.md) | `@altea/altea-mailing-exchange` |
| [MailingPop3.md](MailingPop3.md) | `@altea/altea-mailing-pop3` |
| [Markdown.md](Markdown.md) | `@altea/altea-markdown` |
| [Migrations.md](Migrations.md) | `@altea/altea-migrations` |
| [Printing.md](Printing.md) | `@altea/altea-printing` |
| [Rest.md](Rest.md) | `@altea/altea-rest` |
| [Sms.md](Sms.md) | `@altea/altea-sms` |
| [TimeMachine.md](TimeMachine.md) | `@altea/altea-time-machine` |
| [Tour.md](Tour.md) | `@altea/altea-tour` |
| [ViewLog.md](ViewLog.md) | `@altea/altea-view-log` |
| [WhatsNew.md](WhatsNew.md) | `@altea/altea-whats-new` |

Modules without a page here still carry their narrative in their file headers, and in the app's
`CLAUDE.md`.

**Four pages are ahead of their sources.** Eval, Isolation, Sms and Tour have complete ledgers and moved
file headers, but ~176 member-level divergence notes are still inline in those packages — so for now those
facts live in both places. Finishing them means deciding, note by note, whether the rule binds at the point
of edit or belongs here; the mechanical half is already done.

## Why

altea's sources carried ~48,000 comment lines against Signum's ~5,800 for a comparable codebase — 17%
density against 1.7%. Splitting by subject showed **76% of it was port narrative**; strip that and altea
sits near 4%, which is ordinary for a framework.

Almost none of it was copy-paste (verbatim duplication across files: 1.4%). The redundancy was *vertical* —
the same fact told in `CLAUDE.md`, in the file header, and inline, in three different wordings — and the
cost showed up as drift. Two claims found stale while extracting these pages:

- altea-view-log's header carried a "KNOWN GAP (core, pre-existing)" for something core had since fixed.
- altea-diff-log's data file said `OperationLogTypeCondition.FilteringByTarget` was unregistered, its own
  server file said the opposite, and `CLAUDE.md` sided with the wrong one.

One home per fact is the point.
