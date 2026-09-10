# Signum.Workflow → @altea/altea-workflow

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Workflow/`

A BPMN workflow engine plus the bpmn-js designer: the workflow definition (pools, lanes, activities,
gateways, events, connections), the engine that walks a CASE through it one CASE ACTIVITY at a time, the
Inbox, the case flow view, the activity monitor and the script runner.

The module ports WHOLE. What follows is what a reader needs at the point of edit.

## The one thing that reshapes the port: `withQuoted` is QUERY-ONLY

The transformer emits the quoted AST *beside* the body and leaves the body's inner lambdas unstamped, so
calling a `withQuoted` prototype member IN MEMORY throws "The following lambda has not been quoted" —
where Signum's `[AutoExpressionField]` members work both ways.

Every other module only uses them inside queries, so the asymmetry never showed. The workflow ENGINE needs
both, so each member has a plain query TWIN in `server/CaseQueries.ts` with the same body. Signum's
entity-level `PreSaving` override has no counterpart either — it is a schema event
(`entityEvents(T).preSaving`) — so those two bodies moved to the logic layer.

## No ambient EntityCache, so nothing may be keyed by entity IDENTITY

Signum wraps its graph build in `using (new EntityCache())`, which makes every `RetrieveAll` hand back ONE
instance per row. altea gives each query its own Retriever, so a connection's `from` is a *different
object* than the graph's node for the same row.

`DirectedEdgedGraph` therefore takes an optional `keyOf`, and `fillGraphs`, `getAllConnections`, `trackId`,
`LaneBuilder.getBpmnElementId` and the clone's old→new map all key by the LITE KEY. **An identity-keyed
collection here silently joins nothing.**

## Everything is async

The engine is (`entity.save()` returns a Promise), so:

- `using (WorkflowActivityInfo.Scope(...))` becomes `WorkflowActivityInfo.withScope(info, async () => …)`;
- every evaluator call is awaited, which is why every generated eval wrapper is declared `async` — a
  condition that queries, or an action that saves, has to be. That is the one systematic shape change from
  Signum's synchronous delegates;
- `WorkflowBuilder`'s constructor reads the graph, so `new WorkflowBuilder(wf)` is the static
  `WorkflowBuilder.create(wf)`, and every pass through `Synchronizer.synchronizeAsync` awaits;
- `Validate`'s `changeDirection` callback is async (the builder's implementation SAVES the gateway), and
  `IsStartCurrentUser` is async because role expansion is.

## The eight evals

Signum declares one `IXEvaluator` INTERFACE per hook and its generated class implements it. altea's evals
compile to a FUNCTION — a TypeScript module's natural unit — so each interface becomes a function TYPE, and
the `EvaluateUntyped` shim that widened the typed parameter back to `ICaseMainEntity` disappears with it:
the generated wrapper's parameter is simply typed, and the CALLER holds the untyped value.

The eight `EvalEmbedded` subclasses live beside their owners, as Signum's do (`WorkflowConditionEval` in
WorkflowCondition.ts, `WorkflowLaneActorsEval` in WorkflowNodes.ts, …), which is also what keeps
`data/WorkflowEval.ts` free of a cycle back to them.

## New in core because this module needed it

- **`DirectedEdgedGraph<N,E>`** (edge-valued) beside `DirectedGraph<T>`. Two nodes CAN be joined by more
  than one connection, which is why the edge value is a Set.
- `Synchronizer.synchronizeAsync`; `server/xml/xml{Element,Document}` (promoted out of
  altea-office-template, which keeps re-export shims); `client/Basics/Color` (moved out of altea-chart, plus
  a `Gradient`); the polymorphic-`ModelEntity` serializer branch `BpmnEntityPairEmbedded.model` needs;
  `AuthLogic.rolesInheritingFrom`.

And five core BUGS it surfaced:

- `applyMetadata` did not stamp each DECLARED symbol's id from the blob, so a client symbol was `isNew` and
  `toLite()` threw wherever a symbol is a filter value;
- `EnumCheckboxList` bound NAMES (it read `TypeInfo.members`), which matched nothing — it binds ORDINALS;
- an index selector could not walk EMBEDDED steps (`e => e.scriptExecution!.nextExecution`);
- `Temporal.X.compare(a, b) <op> 0` did not translate to `a <op> b` — and since Temporal has no relational
  operators, that IS how a date comparison is written in a query.

## ESM cycles that are real, and safe

`Workflow.ts` ↔ `WorkflowNodes.ts`, and `CaseActivity.ts` ↔ `CaseNotification.ts`. They are safe because
nothing dereferences the other module at EVALUATION time — the transformer emits a `() => XEntity` thunk
for a field type, and an `@implementedBy` list is a thunk evaluated at schema-build / deserialize time.

**`import type` is NOT an option**: the transformer needs the runtime binding to emit that thunk. Signum
has no such problem — its whole entity model is one assembly and the generated client twin is one file.

## The BPMN bridge

`WorkflowBuilder` is the two-way bridge between the diagram the designer edits and the ENTITIES that store
it: reading assembles one `<bpmn:definitions>` document out of the stored nodes plus each one's own diagram
element; writing diffs the posted document against the stored graph and creates / updates / deletes
accordingly, moving or dropping the case activities of anything that disappears.

- `System.Xml.Linq` becomes altea's own XML element tree. `XNamespace + local name` becomes the QUALIFIED
  name AS WRITTEN (`"bpmn:process"`), which is the same identity for a document that declares its prefixes
  on the root and never rebinds them — BPMN never does.
- Signum parses a stored diagram element by wrapping it in a fake `<bpmn:definitions>` envelope, because
  XDocument resolves namespace URIs. altea's tree matches on the PREFIX, so the bare element parses
  directly and the envelope is unnecessary.
- Signum's three C# PARTIAL classes (WorkflowBuilder / PoolBuilder / LaneBuilder, nested) become three
  classes in ONE file: TypeScript has no nested classes, and splitting them would be an import cycle.
- `GraphExplorer.HasChanges(x)` → `isGraphModified(x)`, the snapshot-based dirty check.

bpmn-js is pinned to Signum's exact 7.5.0 (+ diagram-js-minimap 2.0.4) with hand-written typings; the
custom renderer, context pad, popup menu and minimap are Signum's. `componentWillReceiveProps` becomes
`componentDidUpdate`.

## MList is gone

`mainEntityStrategies` / `actors` / `decisionOptions` / `viewNameProps` are `@part` rows — which is why the
designer has its OWN main-entity-strategy checkbox list, since core's `EnumCheckboxList` edits an array OF
an enum, not of rows.

`WorkflowActivityEntity.boundaryTimers` (Signum's VirtualMList) is a NON-PERSISTED `@column(false)` list the
graph loader fills.

## The Inbox is named by its ROW MODEL

`InboxRowModel`, whose clean name strips the suffix, so the URL is `/find/Inbox`. altea has no
QueryDescription, so a manual query's NAME is its row type and each caption is the field's own `@niceName`;
its column tokens are rooted at that model rather than at CaseNotificationEntity.

Its tokens used to be camelCase literals, because the SERVER's `QueryLogic.getToken` was an exact Map lookup
while `Type.token()` PascalCased — the mismatch the CLAUDE.md token bullet describes, since fixed at the
source. They are built with the typed token builder now, and that mattered more than spelling: a
`hiddenColumns` / `rowAttributes` / `formatters` key is matched EXACTLY against a column name the server
echoes as the resolved token's `fullKey()`, which is PascalCase — so the camelCase keys matched nothing, and
the Inbox rendered with none of its five cell formatters and no per-state row colouring.

## Client divergences

- **The permission gate lives in altea-auth**, not core: `AuthClient.isPermissionAuthorized` reads an
  `allowed` flag stamped onto the permission container's own metadata entry, where Signum ships a
  `permissions` side map read through `AppContext`.
- `EvalClient.Options.checkEvalFindOptions` — the dynamic panel's "do these evals still compile?" pass — is
  a SERVER-side registry here (`EvalLogic.registerEvalSource`, filled by WorkflowLogic), because only the
  server can compile and it needs the rows anyway. `registerDynamicPanelSearch` survives, re-homed on
  @altea/altea-dynamic's DynamicClient.
- `TypeHelpButtonBarComponent` / `WorkflowHelpComponent` / `showWorkflowTransitionContextCodeHelp` are
  dropped: they teach C# against a TypeHelp tree altea does not have. The activity designer's user-help slot
  is an injected seam instead (`WorkflowActivityModelOptions.userHelpComponent`).
- there is no `AutoLineModal`, so "pick an expiration date" and "edit remarks" are two small local modals.
- Signum's `start({ overrideCaseActivityMixin })` flag becomes a per-type call the APP makes
  (`overrideCaseActivityMixinView(EmailMessageEntity, a => a.target)`).
- `ContextualItemsContext` carries `queryToken`, not a `queryDescription`.
- Signum's older navbar `WorkflowDropdown` is NOT ported — its toolbar menu config superseded it.

## Not ported

- `MyActiveAlerts` and the per-notification alert count, and Signum's SMS module: no counterpart here.
- `registerWhenAlreadyFilteringBy` on this module's own types (the mechanism itself IS ported — see
  [Auth.md](Auth.md)).
- `EvalLogic.GetCustomErrors` / `OnInvalidated`, which the [Eval.md](Eval.md) port also declines.
- `AuthLogic.HasRuleOverridesEvent` — "does this role appear as a lane actor?" — has no hook yet.
- `OverrideCaseActivityMixin`'s query re-registration. altea has no SMS module, and re-registering
  altea-email's query FROM here would invert the dependency, so the APP declares the mixin and re-registers
  the query (eastwind does). The mixin's STAMPING does live here: `withCaseActivityMixin` hooks the owner's
  save.
- **Instance TRANSLATION of a workflow / activity name.** `PropertyRouteTranslationLogic` is ported (it
  landed with altea-translations); this module simply does not opt its own routes into it.

> **Stale notes corrected.** Three headers described neighbours that had since moved, and two of them had
> ALREADY been corrected in the app's CLAUDE.md while the module's own comment went on saying the old thing:
>
> - `CaseActivityLogic` said `PackageExecuteAlgorithm<CaseActivityEntity>` "has no altea counterpart
>   (altea-processes ports the Package TABLES but not the generic package-execute algorithm)". It is
>   `altea-processes/server/PackageLogic.ts:183`. The timeout algorithm walking its own package lines is
>   still the right call for this module — that is why it needs none of it — but the reason given was
>   false.
> - `WorkflowLogic` said `PropertyRouteTranslationLogic.RegisterRoute` "has no altea counterpart yet".
> - `WorkflowLogic` said `EvalLogic.GetCustomErrors` / `OnInvalidated` "go with the Eval deferral". Eval is
>   ported; those two members are declined on their own merits.
> - `WorkflowClient` said the tokens in its two Finder settings blocks had to be camelCase LITERALS because
>   "the SERVER's `QueryLogic.getToken` is a strict Map lookup". True when written, not now. Correcting it
>   turned out to uncover a live defect rather than a spelling preference — the Inbox's `formatters` and
>   `rowAttributes` keys are matched EXACTLY and so had never fired. Both blocks use the typed builder now;
>   see [OpenQuestions.md](OpenQuestions.md) §2.3.
