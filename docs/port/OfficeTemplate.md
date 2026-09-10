# Signum.Word + Signum.Excel → @altea/altea-office-template

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Word/` + `old/Framework/Extensions/Signum.Excel/`

One package holds two Signum ones, because they share an OOXML substrate that had to be hand-built either
way. It carries the docx/pptx/xlsx TEMPLATE engine, and the whole of Signum.Excel: the plain export, the
importer, and the stored ExcelReport templates.

## Word → Office: why the package is not called `altea-word`

Signum named the module after Word, but the SAME engine templates .docx, .pptx AND .xlsx — the parser
dispatches on the OOXML namespace of each paragraph, not on the file type. So `Word*` becomes `Office*`
throughout the public surface:

| Signum | altea |
| --- | --- |
| `WordTemplateEntity` | `OfficeTemplateEntity` |
| `WordModelEntity` | `OfficeModelEntity` |
| `WordTransformerSymbol` / `WordConverterSymbol` | `OfficeTransformerSymbol` / `OfficeConverterSymbol` |
| `WordAttachmentEntity` | `OfficeAttachmentEntity` |
| `WordTemplateOperation.CreateWordReport` | `OfficeTemplateOperation.CreateOfficeReport` |

Everything else keeps Signum's names and member order, so the two stay diffable: **when re-applying a
Signum change, read `Word` for `Office`.**

The rename reaches the DATABASE, which is what `@legacyTableName` / `@legacyColumnName` /
`useLegacyWordSymbolNames()` are for — see the CLAUDE.md bullet. Registering the symbol re-keying surfaced
that `OfficeTemplateOperation.CreateOfficeTemplateFromOfficeModel` was DECLARED and never registered, so
the operation did not exist at runtime.

## The template tree lives INSIDE the document

This is the design that makes the module work, and it is worth stating plainly: a Word template's control
flow is not a separate syntax tree sitting beside the document, it is spliced INTO it. The parser replaces
the runs that spell `@foreach[…]` with a `ForeachNode` element in the very position those runs occupied, so
the node's parent chain — table row, cell, paragraph — is the thing that gets repeated. Rendering walks
`descendants of BaseNode` and each node rewrites its own neighbourhood.

A token is SHATTERED across runs by Word (a single `@[Customer.Name]` typically spans ~7 runs, because
spell-check and formatting split it), which is why parsing is a two-pass reassembly.

- `AlternateContent` — the SDK element Signum's nodes derive from — does not exist here, so the nodes
  derive from `OxmlElement` with the qualified name `mc:<ClassName>`. That mirrors Signum's `LocalName`
  override exactly: a node that survives to serialization writes itself out VISIBLY, which is what makes
  `assertClean` a meaningful check rather than silent corruption.
- `IFormattable` / `SafeFormat` collapse into @altea/altea-templating's `formatTemplateValue`, which already
  handles enum / bool / Temporal / Decimal for text templates.
- `ProcessOpenXmlPackage(document => …)` becomes explicit: `OxmlPackage.load` / mutate / `save()`.
- `CultureInfoUtils.ChangeBothCultures` has no counterpart — the culture is threaded through
  TemplateParameters rather than an ambient thread culture, so there is nothing to swap.
- The whole render path is ASYNC, because query execution is.

### Images and tables are addressed by ALTERNATIVE TEXT

There is no token syntax for "put a picture here" or "bind this table", so both use the shape's alt text —
in Word, right-click the image → Format Picture → Alt Text → Title. The drawing, its size, its position
and its wrapping stay the author's; only the bytes or the cell contents change.

`IImageConverter<TImage>` exists for the same reason as in Signum (System.Drawing is Windows-only, so the
image library is pluggable), but here it is OPTIONAL: the default currency is raw BYTES, so the common case
— replace this placeholder with these PNG bytes — needs no image library at all. A converter is required
only for `adaptSize`, which has to decode the placeholder to learn its pixel size and re-encode the result.
Signum's two concrete converters are .NET-only and are the pluggable half by design; an app that wants
`adaptSize` supplies its own.

## The Excel three

### PlainExcelGenerator — a ResultTable straight to .xlsx

Built FROM a small .xlsx resource copied byte-for-byte from Signum (`Resources/plainExcelTemplate.xlsx`)
that carries the STYLES: its cells A1 / A2 / B3…K3 are formatted as the title / header / date / … styles,
and their `s=` indexes ARE the DefaultStyle map. Only the worksheet's `<cols>` + `<sheetData>` are
replaced, so the theme, fonts, number formats and column widths of Signum's exports are reproduced exactly.

- **Wrap-text is ONE format per file, not one per cell.** Signum's `ApplyWrapTextStyle` appends a new cell
  format per multi-line cell — thousands of formats for a large export.
- `WritePlainExcel<T>(IEnumerable<T>)` derives its columns by REFLECTION over T. TypeScript erases that,
  so the counterpart is `writeStringTable`, where the caller names the columns — and its reader
  `readStringTable` is what makes the two a ROUND TRIP: @altea/altea-translations exports its per-type
  translation sheets with one and re-imports the edited file with the other.
- **The markup flatteners are a plain import**, the dependency edge Signum.Excel also has (its csproj
  references Signum.HtmlEditor and Signum.Markdown for exactly these two calls). A registry seam would have
  to live in altea CORE — neither module may depend on this one — and would need each of them to grow a
  server `start` purely to register, which Signum.Markdown does not have at all.

### ExcelReportGenerator — a stored WORKBOOK, refilled

The template is a workbook someone built IN EXCEL: a "Data" sheet with a header row and one sample data
row, plus whatever else they wanted — pivot tables, charts, sheets whose formulas read the data. Running
the report replaces the Data sheet's contents with the query's rows, keeps each column's formatting from
the sample row, and repoints every pivot cache at the new range. Nothing else is touched.

Two things make it work, and both are the template AUTHOR's contract rather than anything stored:

- a column is matched by its **display name** — the header cell's text against the query column's caption
  — so the template says which columns it wants and in which order;
- the **sample row** below the header supplies each column's style, which is how a template formats a date
  column, colours a total and sets a number format without any of it being described in code.

Divergences:

- **the "Data" worksheet is looked up more forgivingly.** Signum reads
  `GetWorksheetPartBySheetName(ExcelMessage.Data.NiceToString())` — the LOCALIZED name — so a template
  authored in one culture cannot be run in another. The port tries the localized name, then the invariant
  "Data", and finally accepts a workbook with only ONE worksheet; only a multi-sheet workbook with no
  recognisable data sheet fails.
- **the output column ORDER is built explicitly** — template columns in template order, then any query
  column the template does not mention. Signum gets the same order out of a `HashSet<K>` it unions the two
  key sets into: true of .NET's HashSet in practice, but not a documented guarantee, and a file's column
  order is not something to leave to one.
- **the calculation chain is DROPPED, not just flagged.** Signum sets `ForceFullCalculation` /
  `FullCalculationOnLoad` and leaves the chain naming cells that no longer exist — which is what makes
  Excel offer to "repair" the file.
- the `.xlsx` extension is a field VALIDATION as well as the run-time assert, so a template saved with the
  wrong extension is refused when it is SAVED rather than the first time someone runs the report.
- `GetColumnWidth` is dead code in Signum and is not ported: an ExcelReport takes its widths from the
  template, which is the point of having one.
- `ExcelReportEntity` lives in its own `data/excel/` directory, because the schema scope is per PACKAGE +
  DIRECTORY and `data/OfficeTemplate.ts` already claims `data/` for the `word` schema — a second
  `setDefaultDatabaseSchema` for one directory REPLACES the first. The longest-prefix rule then puts this
  one table in Signum's `excel` schema.

### ExcelImporter — read an .xlsx back into entities

The query's COLUMNS say which property each sheet column assigns, its FILTERS supply constant values, and
one operation saves each resulting entity. Signum's whole shape is kept (ParseQueryRequest → the per-row
loop → ImportResult per row) and so are its error messages. Four things diverge, all forced by the model:

1. **No compiled setters.** Signum builds each column's getter/setter with
   `PropertyRoute.GetLambdaExpression(...).Compile()`. An altea entity is a plain object and a property
   route IS a member path, so an assignment is a WALK over segments — no expression trees, and missing
   embeddeds along the path are simply constructed.
2. **MLists are gone.** Signum groups `MList<embedded>` rows and synchronises them by key. A collection is
   an array of `@part` ROW entities (or of rows whose `@valueField` holds a scalar), so "create an element"
   is `new RowEntity()` + assign the relative segments, and matching an existing element compares the key
   column's value read off that row.
3. `Administrator.DisableIdentity` has no counterpart: the save path writes an explicit PK whenever a NEW
   entity already carries an id, so `model.identityInsert` only decides whether the Id column MAY be
   assigned.
4. **The root type is unambiguous.** Signum inspects the QueryDescription's Entity-column implementations
   and refuses a query with several; an altea query's shape is a single reflected type, so that check
   survives only as the "not an entity query" case.

### CellBuilder — one value, one `<c>`

The style map is keyed off the TOKEN's `filterType` — the same discriminator the SearchControl editors and
the importer use — plus the token's `type` for the enum object, where Signum keys off .NET `TypeCode`. That
removes the Char / SByte / DBNull rows entirely and makes `PlainDate` / `PlainDateTime` / `PlainTime`
distinct without extra probing.

Values arrive as altea runtime types: `Temporal.PlainDate(Time)`, a decimal.js `Decimal` (or, from some
numeric columns, a raw string — the projector does not always box it), a `Lite`. An ENUM value in memory is
its ORDINAL, so the display name comes from `Enum.niceName(enumObject, ordinal)` and the
import-round-trip name from `Enum.toName`. Multiline detection reads `FieldInfo.isMultiline` rather than
hunting for a MultiLine StringLength validator.

## The model side

`OfficeModelLogic` is structurally identical to @altea/altea-email's `EmailModelLogic`, deliberately:
Signum's two files are near-copies of each other, so the ports should be too. `WordModel<T>`'s abstract
base becomes an `officeModel()` factory, `QueryDescription` is gone (a model shapes its query from the
`queryName` alone), and the request-DTO converters are SHARED with altea-email rather than duplicated.

`Lite<FileEntity> Template` is a FileEntity REFERENCE, as in Signum, so the column is `Template_ID` into
`files.file`. altea keeps a FULL reference rather than a lite — the column is the same either way, every
reader needs the bytes, and altea's file LINES cannot bind a lite — which brings Signum's
**superseded-file dance** with it: a FileEntity is IMMUTABLE, so replacing a template's document makes a
NEW row and the Save operation schedules the old one's delete on `Transaction.preRealCommit`.

## Token migrations

`OfficeTemplateTokenSync` subscribes to `TokenMigrationLogic.TokenSynchronizing` and repairs a template's
stored QUERY tokens — its filters and orders — through the shared `TokenSyncWalker`. See
[UserAssets.md](UserAssets.md).

**What is NOT repaired is the document BODY.** An office template's `@[Customer.Name]` lives in the
.docx/.pptx/.xlsx bytes, which Signum walks with `TemplateSynchronizationContext` over the parsed document.
That pass is the same follow-up [Templating.md](Templating.md) describes, and its prerequisites now exist.

> **Stale notes corrected.** `OfficeTemplateLogic`'s header said "`TokenMigrationLogic` (the stored-token
> migration pass) is not ported; altea has no such subsystem" — while the same file imports and registers
> `OfficeTemplateTokenSync`. `OfficeTemplateNodes` said `Synchronize` was dropped because "altea has no
> template-sync pass". The DOCUMENT-body half is genuinely missing, which `OfficeTemplateTokenSync`'s own
> header says correctly; the subsystem is not.

## The client half of Signum.Excel

The package shipped `PlainExcelLogic` / `ExcelImportLogic` and their three routes since the Word port, with
nothing calling them. `ExcelClient` / `ExcelMenu` / `ImportExcelProgressModal` / `Templates/ImportExcelModel`
are that missing caller, so "Export to Excel" and "Import from Excel" are on the SearchControl toolbar and
the export on the chart page, as in Southwind.

- **`QueryDescription` is gone**, so the imported type comes off the query's ROOT token
  (`Finder.getQueryRoot(...).type.typeInfos()`) where Signum reads `qd.columns["Entity"].type`, and the
  collection token the validate route answers with is a STRING that `Finder.parseSingleToken` resolves.
- `token.fullKey` / `queryTokenType == "Element"` are METHODS (`fullKey()` / `isElement()`), a
  `getTypeInfo(t).operations` read becomes `Operations.operationInfos(ti)`, an enum FIELD holds its ORDINAL
  so `mode` compares through `ImportExcelMode.*` rather than string literals, and the per-row label is
  built OUTSIDE the JSX attribute — the transformer does not rewrite a lambda there.
- an export writes what the REQUEST says, so a paginated search has to be ASKED which pages to write.

That work exposed a core gap with nothing to do with Excel: **`/api/operation/stateCanExecutes` did not
exist**, so every contextual right-click on a search whose type has a ConstructFromMany died. See the
CLAUDE.md bullet for the route, the `onAnyReadonly` seam and the two client bugs fixed beside it.

Still NOT ported: `ExcelAttachmentEntity` — a UserQuery exported to .xlsx as an email attachment, which is
what this module's own attachment already does.
