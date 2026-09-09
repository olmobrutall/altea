# Signum.Markdown → @altea/altea-markdown

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Markdown/`

Three small things: the "Markdown" query-column format rule, the `MarkdownLine`, and `markdownToText` for
the excel export.

## The substrate: Markdig → mdast

`Markdig.Markdown.Parse(markdown, pipeline)` becomes `fromMarkdown(markdown)` — the parser react-markdown
itself is built on, which makes this the one flattener in the workspace that does NOT need a hand-written
tokenizer (@altea/altea-html-editor's `HtmlToPlainText` does, because there is no HtmlAgilityPack for Node
and the server has no DOM).

Both parsers default to plain CommonMark with no extensions: `new MarkdownPipelineBuilder().Build()`
enables none, and `fromMarkdown` with no `extensions` enables none. So a GFM table is not parsed on either
side and comes through as the literal pipe text — same output, same reason.

The trees line up node for node:

| Markdig | mdast | handled as |
| --- | --- | --- |
| `MarkdownDocument` | `root` | recurse |
| `ParagraphBlock` | `paragraph` | inlines, then a newline unless inside a list item |
| `HeadingBlock` | `heading` | inlines, then a newline |
| `ListBlock` / `ListItemBlock` | `list` / `listItem` | `"- "` or `"1. "` per item, then a newline |
| `ContainerBlock` (quote, …) | `blockquote`, … | recurse, transparently |
| `LiteralInline` | `text` | appended verbatim |
| `LineBreakInline` | `break`, and the `"\n"` already inside a text | a newline |
| `CodeInline` | `inlineCode` | its content, without the backticks |
| `ContainerInline` (strong, emphasis, link, …) | `strong`, `emphasis`, `link`, `delete`, … | recurse, so the emphasis markers vanish |

Two things that leaves out, both mirroring Signum rather than improving on it — kept as-is so the two
implementations stay comparable and a future Signum fix re-applies unchanged:

- **a CODE BLOCK contributes NOTHING.** Markdig's `CodeBlock` is a LeafBlock, so Signum's switch — which
  has cases for the container kinds and for Paragraph / Heading / List only — never reaches it, and the
  same holds for `ThematicBreakBlock` and `HtmlBlock` (mdast: `code`, `thematicBreak`, `html`).
- **an ordered list renumbers from 1**, ignoring the list's own `start`, so a `3.` list flattens as `1.`.

One place mdast is poorer than Markdig, so it needs a line of code rather than a recursion: Markdig models
an IMAGE as a `LinkInline` whose CHILDREN are the alt text, which Signum's `ContainerInline` case walks
into; mdast makes `alt` an attribute of a childless `image` node. Appending that attribute is what
reproduces Signum's output.

`test/markdownToPlainText.test.ts` pins each node kind, and says at each case where Signum's behaviour is
being mirrored rather than fixed.

## Divergences

- **`MarkdownMessage` lives in this package**, where Signum declares it in its CORE assembly beside every
  other message container — the same call `HtmlEditorMessage` made. Nothing outside reads it, and a message
  in core has to be translated by every application whether or not it installs the module.
- **`markdownOption` is actually APPLIED.** Signum declares the prop on `MarkdownLineProps` and never reads
  it — its `<Markdown>` call passes only the children — so a caller asking for custom components or remark
  plugins silently got the defaults. Same shape as the `controller.editorState` bug @altea/altea-html-editor
  fixes rather than mirrors: a declared prop that does nothing is a bug, not a behaviour to preserve.
- **the cheat-sheet's right column RENDERS the left column's markdown** rather than being hand-written
  HTML, so it cannot drift from what the editor does. Signum hand-wrote `<strong>H1</strong>` because a
  `<p>` would add a margin and an `<h1>` would be twice the popover's font size; mapping the elements to
  compact ones keeps that look without the drift.
- **`helpTextOnTop` is forwarded only in its plain form.** It may be a function of the controller (altea's
  `LineBaseProps`, as Signum's), but this component renders the FormGroup itself and has no controller to
  hand it.

## What it filled in outside itself

- **`htmlToText` was dead code.** Signum's `PlainExcelGenerator` flattens a column whose property format is
  Html or Markdown and lays it out multiline; altea's had no such branch at all, so a rich-text column
  exported as raw markup. Both flatteners are now reached by a plain import — the dependency edge
  Signum.Excel also has. (A registry seam would have to live in altea CORE, since neither module may depend
  on altea-office-template, and would need each to grow a server `start` purely to register — which
  Signum.Markdown does not have at all.)
- **the FontAwesome BRANDS set was missing.** `library.add(fas, far)` is all Southwind does too, so this
  module's `["fab", "markdown"]` cheat-sheet marker and altea-auth-windowsad's `["fab", "windows"]` sign-in
  icon both rendered as an empty span. Signum declares the package; eastwind now adds `fab`.

With this module ported, altea-agent's SkillCustomization and altea-tour's TourStep use the real
`MarkdownLine`, as Signum does — both had stood in altea-codemirror's `MarkdownCodeMirror`, which stays as
the syntax-highlighting alternative.
