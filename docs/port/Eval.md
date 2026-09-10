# Signum.Eval → @altea/altea-eval

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Eval/`

A SCRIPT stored in the database, compiled to a callable on first use, cached by its generated source, and
re-validated whenever it is saved. Signum stores C# and compiles it with Roslyn; altea stores TYPESCRIPT
and compiles it with the TypeScript compiler — which is already a build dependency, so the "compiler
service" Signum needs Roslyn for is simply there.

## What the language change does to the shape

- **`T` is a FUNCTION TYPE, not an interface.** Signum generates a class implementing `IXEvaluator` and
  instantiates it; a TS module's natural unit is a function, so a subclass declares
  `EvalEmbedded<(e: OrderEntity, ctx: X) => boolean>` and the generated source's DEFAULT EXPORT is that
  function. The `EvaluateUntyped` shim Signum's generated class needs — to widen the typed parameter back
  to the interface's — disappears with it: the wrapper's parameter is simply typed, and the CALLER holds
  the untyped value.
- **What a script may reach is a MODULE REGISTRY, not a namespace list.** `EvalLogic.Namespaces` +
  `AssemblyTypes` become `EvalLogic.registerModule(specifier, value)`, and it is SINGLE-SIDED: the same
  specifier is what the generated code imports (so the TYPE side resolves) and what the sandboxed `require`
  hands back (so the VALUE side is exactly what the app allowed). **An unregistered import fails to run
  even if it type-checks against node_modules** — which is the point. `EvalLogic.addPreamble` is
  `GetUsingNamespaces()`.
- **the module SEEDS ITS OWN framework surface** (`EvalFrameworkModules`), as Signum seeds mscorlib /
  System.Linq / Signum.Utilities. An application registers only its entity domains — which need
  `typesPath`, since nothing depends on an app — and a module outside the framework registers its own from
  its own `Logic.start` (altea-workflow does). Southwind calls `EvalLogic.Start(sb)` and adds nothing.

## Compiling is two passes

Signum parses the generated C#, compiles it against a list of `MetadataReference`s (one per allowed
assembly), emits to a MemoryStream, loads the assembly and instantiates the single type implementing the
evaluator interface. The analogue:

1. **TYPE-CHECK** the generated module with `ts.createProgram` over the app's own compilerOptions, so an
   author gets real diagnostics ("Property 'foo' does not exist on type 'OrderEntity'") against the real
   `.d.ts` of every package the app allowed — the direct counterpart of Roslyn + MetadataReferences.
2. **TRANSPILE** it to CommonJS (`ts.transpileModule`, which does no resolution) and run it with
   `new Function(exports, require, module, …)`, where `require` answers ONLY from the module registry.

- Signum loads each compiled script into a fresh `AssemblyLoadContext`; there is no JS equivalent and no
  need for one (a module here is a closure, not a loaded assembly), so nothing is ever unloaded — the
  per-code cache is what keeps that bounded.
- **`EvalLogic.OnInvalidated` clears the code-keyed compilation cache**, Signum's `resultCache.Clear()` on
  the same event: a registered module changing can change what an already-compiled script means.
- `GetCustomErrors` (Signum.Dynamic used it to forbid certain API in generated code) has no caller yet, so
  it is not ported; the natural equivalent would be a diagnostic pass here.

## Divergences

- **The compiler is an INJECTED SEAM.** The data module is isomorphic — the client renders the editor and
  must not carry a compiler — so `EvalEmbedded.compiler` is a slot `server/EvalCompiler` fills. Unset (in
  the browser) every compile answers "not compiled" and the script validator stands down, which is why the
  validator only runs in the SERVER phases.
- **The owner comes from `@bindParent`**, as in Signum: the field that holds an eval is marked, and
  `owner()` reads the back-pointer — which is how a WorkflowConditionEval learns its WorkflowCondition's
  `mainEntityType`. This module used to keep a private WeakMap of owners bound by a
  `sb.include(X).withEvals()`; core has `data/parentEntity` now, and that generalised copy is what this
  uses.
- **`owner()` climbs to the nearest ENTITY**, not to the immediate parent, because an eval may sit one
  embedded down (`SubWorkflowEmbedded.subEntitiesEval`) and what it wants is still the entity carrying it —
  Signum reaches the same place with a two-level `GetParentEntity` climb. An eval carried by a MODEL is
  left UNBOUND on purpose, since a ModelEntity is never included: validation skips it, and the real check
  runs when the model is applied and its entity saved.
- **There is no `Reset()` and no `withEvals()`.** Signum needs `Reset()` because it drops the cached
  compilation from the `Script` setter, and altea has no setters — which is what `withEvals()` used to
  stand in for, resetting on the `retrieved` schema event. Both are gone: the memo records the script it
  compiled, so a hit only counts while that is still the script on the instance. That also covers the case
  the retrieve hook never did — a script REPLACED on an instance that had already compiled, which is what
  the codec does when it overlays a POST onto a retrieved original.
- **the compilation result lives in a module-level WeakMap** rather than an `[Ignore]` field: a declared
  field would be reflected (and so serialized, and schema-mapped) whatever we annotate it.
- **the CHECK-EVALS registry is SERVER-side** (`EvalLogic.registerEvalSource(name, load)`), where Signum
  keeps a list of client FindOptions: only the server can compile, and a filter Signum needs a
  QueryRequest for ("only lanes with an actors eval") is a `.filter(...)` here. So ONE call checks
  everything and the response says which source each failure came from, where Signum's client loops.
- Signum's two conveniences are kept: a script with no `;` is treated as an EXPRESSION (`return … ;`).
- `EvalPanelPermission` is the ONE ViewDynamicPanel, as in Signum: @altea/altea-dynamic's panel page reads
  it from here rather than declaring a second under its own container — two containers would be two
  permissions, and a role granted one would not have the other. It lives in its own module because a
  permission container is a symbol container, grouped by the container half of the key.

## Not ported

- **`TypeHelp`** — the honest equivalent is real editor IntelliSense over the same `.d.ts` the server
  type-checks against, which is a project rather than a port. Signum shows a TypeHelpComponent tree beside
  the editor; `HighlightText` (its search-hit renderer for Code / JSon columns) goes with it.
- **the EvalPanel PAGE** — altea-dynamic owns the admin pages, so `EvalPanelPermission` lives here but
  `registerDynamicPanelSearch` stays on `DynamicClient`. That is why `EvalClient.start` registers nothing
  today: it exists so the module has the same shape as every other altea client.

## The editor

Signum spells the signature / editor / closing-brace sandwich out inline in each of its eval views
(WorkflowCondition.tsx and friends); altea factors it into one `EvalLine`, because there are eight of them
in altea-workflow alone and they differ only in the signature. The COMPILE ERRORS come back as an ordinary
field error on `script` — `EvalEmbedded`'s validator is what produces them, Signum's `PropertyValidation` —
so they render through the FormGroup like any other validation message, and the offending line is
highlighted.

## A note on trust

**A compiled script runs IN PROCESS with the server's rights**, exactly as Signum's Roslyn-compiled C#
does. Authoring one is gated by the owning entity's Save operation and by `EvalPanelPermission`; there is
no sandbox, and pretending otherwise would be worse than saying so.
