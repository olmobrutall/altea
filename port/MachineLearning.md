# Signum.MachineLearning → @altea/altea-machine-learning

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.MachineLearning/`

A predictor names a registered QUERY, marks each of its columns Input or Output, trains a model over the
rows, and predicts with it. The module ports whole: the definition, the column codification, a neural
network, the training orchestration, the two result savers, the genetic autoconfigure search, and the
interactive predict page.

## A CODIFICATION is the unit

One codification is ONE NUMBER in the model's input or output vector. That is why the codifications are
PERSISTED rather than recomputed: a prediction made months later must land in the same slots, with the same
normalization statistics, as the training did.

Everything else — the tensors, the network, the metrics — is derived from the (query, column list) pair,
which is why a rename in the schema breaks a predictor the same way it breaks a user query (see
[UserAssets.md](UserAssets.md) on token migrations).

## CNTK becomes TensorFlow.js

`@tensorflow/tfjs-core` + `-layers` + `-backend-cpu` are the substrate. `tfjs-node` is an OPTIONAL backend
registration for the same API — `useBackend("tensorflow")` — and `/api/predictor/backend` says which one is
live, because a pure-JS backend trains the same model far slower and that is worth knowing rather than
guessing.

## Training is asynchronous, and the run is not in the operation's transaction

A predictor is Draft while it is being defined, Training while a run is in flight, Trained when a model is
on disk, and Error when a run failed. The operation flips the state and STARTS the work; the work commits
its own progress. That is why `trainingProgress` is an endpoint rather than the operation returning a
result.

Signum tracks each run on a `Task` in a static dictionary keyed by the predictor's id; here it is a Map of
`AbortController`s — the same bookkeeping, plus a cancellation handle Node actually has.

## MList → `@part` rows, and the main query's filters hang off the PREDICTOR

Every `MList` becomes `@part` rows: the sub-queries (Signum's virtual MList), the files, the columns, each
sub-query's filters and columns, and the hidden layers. That is what turns Signum's 19 entity classes into
27 tables.

Signum keeps the main query's filters and columns INSIDE `PredictorMainQueryEmbedded`; a `@part` collection
needs a real owner TABLE, so `PredictorEntity.filters` / `.columns` are the predictor's own and the embedded
keeps only `query` + `groupResults`. The designer still presents them as one "main query" block.

## The ROOT entity token is `""`

Where Signum spells it `"Entity"` — altea has no storable root token. It bit both tiers: the predict path's
filter, and the sub-query creator's ParentKey seed.

## `isValue` and the split keys round-trip through the filter-value converter

`stringifyFilterValue` / `parseFilterValue`, the counterpart of Signum's `FilterValueConverter`, and
`objectArrayKey` keys a Lite by its KEY.

**Getting this wrong is silent.** A Lite's `toString()` is its DISPLAY text while the one-hot dictionary
looks a value up by `lite.key()`, so a stored "Margaret Peacock" never matched an incoming "Employee;4" —
every one-hot column over a reference matched nothing at PREDICT time and answered as if the value were
unknown. Training is unaffected (the values are still live objects there), which is exactly why it hides.

`objectArrayKey`'s separator and its null sentinel are U+0001 and U+0000, chosen because neither can appear
in a lite key or a display string. They are written as `\u0001` / `\u0000` ESCAPES: as raw bytes they made
the file binary to grep, ripgrep and anything else that scans the tree, which is a real cost for no gain —
the compiled string is identical.

## `inputsFromEntity` fills EVERY column, outputs included

Signum's `FromFilters` does the same, and it matters: one dictionary is both the prediction's inputs and the
record of what actually happened, which is what lets the predict page show "the model says 98.53, the truth
was 38.28". The outputs are ignored when the vector is encoded, so carrying them cannot influence the
answer.

## Two arithmetic differences, both deliberate

The encodings are where a wrong answer is silent and expensive — a mis-scaled column trains a worse model
with no error anywhere — so the reference implementation IS the specification here, and the comments in
`server/tensorflow/Encodings.ts` cite it deliberately. Two places diverge:

- **the z-score guards a zero standard deviation.** Signum divides regardless and produces NaN; a column
  whose every value is the mean is degenerate, not an error, and 0 is the correct z-score for it.
- **an empty set's defaults are the IDENTITY** (a 0 average with a 1 stdDev / a 0..1 range), so an
  untrained or empty column passes its value through rather than annihilating it.

An unknown category is all-zeros, which is what Signum writes too, and the bag-of-words split is
case-INSENSITIVE, matching Signum's `StringComparer.CurrentCultureIgnoreCase` dictionary.

## The interactive prediction is a PAGE, not a modal

`/machineLearning/predict/:predictorId?entity=<liteKey>`, so a prediction has a shareable URL. The content
is Signum's `PredictModal`: editable inputs, a re-prediction per edit through an `AbortableRequest`, the
original dimmed while one is in flight, and the alternatives checkbox for a classification.

Its wire DTOs live in the DATA layer and carry a token as a STRING, which the page resolves through
`Finder.TokenCompleter` — there is no QueryDescription, so a serialized token DTO would be a second, weaker
copy of a model the client already builds. `PredictDictionary.options` carries the decode options (Signum's
same field), so a batch may mix rows asking for alternatives with rows asking for the winner.

## The loss chart is inline SVG

Not Signum's d3 `LineChart`: a fixed two-series line chart over a few hundred points needs no scale
abstraction, and it keeps the module off a charting dependency for one view.

The validation series is drawn with GAPS, because it is only recorded every `saveValidationProgressEvery`
epochs and joining across them would draw through points nobody measured. The four grid formatters keep
Signum's light/dark colour pairs for the same reason — the two curves DIVERGING is what overfitting looks
like.

## Registration details worth knowing

- **the four symbol tables need `SymbolLogic.start`**, whose `withQuery()` the designer's algorithm /
  encoding / result-saver combos need: they load their options by RUNNING the type's query. They come LAST
  in `start`, because the default `getSymbols` is "every DECLARED symbol of this type" and a declaration
  happens when its container is first touched — `registerAlgorithm` / `registerResultSaver` above are what
  touch them.
- **`IgnorePinned` is called by the MODULE**, not left to the app as in Southwind: altea's filter rows share
  `QueryFilterBaseEntity`, so those seven pinned columns exist unless the module says otherwise, and an app
  that forgot the call would silently get a schema Signum does not have. It must precede the includes, the
  same ordering rule Signum has.
- `PredictorSubQueryEntity` gets a search page of its own, as Signum gives it one; the codification table
  does NOT (it is reached from the predictor it configures), so a Signum database has no `basics.query` row
  for it.
- `[BindParent]` has no counterpart, so the two places Signum uses the parent — a hidden layer validating
  against the predictor's output columns, and `ParseData` — take it as an ARGUMENT instead.
- `StateValidator` (Signum's table-driven per-state required/forbidden matrix) becomes per-field
  `@validate`, the translation @altea/altea-email already made for the same construct.
- `IPredictorAlgorithmSettings` is a TS INTERFACE, so `algorithmSettings` is `@implementedBy` over the
  concrete settings entities. This module DOES depend on the one it ships, so the implementation is named
  here rather than widened by the app.
- `NeuralNetworkSettingsEntity` is Transactional, following its owner, where the declaration used to say
  Master — Signum's own declaration is the owner's too (see CLAUDE.md on `@part` deriving EntityData).
- **the four network enums keep Signum's member names**, which are TensorFlow/Keras function names — and so
  is `NeuralNetworkHidenLayerEmbedded`'s typo, because the name is reflection IDENTITY and a translation
  file keys on it.
- the metrics Signum computes in `PreSaving` (the classification miss rate) are computed by the training
  run, since there is no entity-level PreSaving hook — see `finishTraining`.
- `ProgressBar` is local (the framework has none) and `initializeColumn` is its own module: Signum imports
  it back out of `Templates/Predictor.tsx`, a cycle that survives only because a function declaration is
  hoisted.

## Not ported

- the CSV / TSV / TensorFlow-projector export links — a matrix serializer plus three routes, and the
  projector link is a `window.open` of a public site. `PredictorMessage` keeps their labels.
- `PredictorEntity.MainQuery.ParseData`, gone with QueryDescription: a token is resolved where it is USED
  (`PredictorLogicQuery`), so a stale one fails at TRAIN time with the predictor named rather than being
  precomputed.
- Signum's `getHelpBlock` (a switch that can only produce an empty string or an exception), with its unused
  `LabelWithHelp`.
- `OperationLogic.AllowSave` / `PermissionLogic.RegisterPermissions` / `ExceptionLogic.DeleteLogs` — the
  notes every other port carries.

## Two core bugs it surfaced

Both older than this module, and both app-wide:

- **`Navigator.hasAllowedConstructor` denied construction for every type with no plain Constructor
  operation.** Signum's rule is "if a CONSTRUCTOR operation exists for the type but the role may not run
  it, refuse", read off a server-computed `TypeInfo.hasConstructorOperation`; altea approximated it as "does
  any operation exist that is neither Execute nor Delete", which a **ConstructFrom** satisfies — so the
  moment altea-alert / altea-notes registered `CreateAlertFromEntity` / `CreateNoteFromEntity` on `Entity`
  (inherited by every type), every `@part` row type answered false. Visible symptom: no "Create" row on any
  EntityTable / EntityRepeater over a `@part` collection — a UserQuery's columns and orders could not be
  added to — and no "Create new X" button on such a type's search page.
  `TypeMetadata.hasConstructorOperation` now carries the flag, computed in `ReflectionServer.buildMetadata`
  BEFORE the per-role filter (the one field there that is deliberately role-independent).
- **`QueryTokenEmbeddedBuilder` never resolved a STORED token.** `QueryTokenEmbedded.token` is
  `@serialize(false)` — the server only ever sees `tokenString` — and nothing revived it on load, so every
  stored column / order / filter of every UserQuery, UserChart and template rendered the token builder's
  "…" placeholder forever and could not be edited without re-picking. It resolves there now (in local
  state, so an untouched form does not look modified), and a token that no longer resolves shows its
  message instead of hanging.

Plus a smaller pair in the Lines, both in the path of a JSX `label`: `isLabelVisible` was
`!(style === "SrOnly" || "visually-hidden")` — a precedence mistake whose bare string literal made it ALWAYS
false — and the accessible name was `String(p.label)`, which for a React element is the literal text
"[object Object]". Both now go through `client/Lines/ariaLabel.ts`.
