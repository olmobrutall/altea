import { Entity } from "./entity";
import { reflect } from "./reflection";
import { column } from "./decorators";

// Port of Signum's ImmutableEntity (Signum/Entities/Patterns/ImmutableEntity.cs) — the base for a row
// that must not change once it is saved. Its one implementor here is `FileEntity`, and the reason is the
// SHARING: a file row may be referenced by several owners, so mutating it would change the file under
// every one of them. Replace the reference instead.
//
// Signum's base is two halves, and only ONE of them is a rule:
//
//   • `Set` — the property-setter interception, which SILENTLY SWALLOWS a write to a saved row
//     (`base.SetIfNew`). altea entities are plain field bags with no setter seam at all, so there is
//     nothing to override and nothing that could be. It is not missed: swallowing a write is the worse
//     half anyway — the caller believes it changed something and finds out later, somewhere else.
//   • `PreSaving` — throws when a non-new instance is `SelfModified`. THAT is the rule, and altea has
//     the state it reads exactly: `isModifiedSelf()` (a value diff against the row's snapshot). So the
//     guarantee ports one for one and is reported LOUDLY where Signum reports it not at all.
//
// altea divergences:
//  - **`allowChange` is a FIELD, where Signum's is a computed property over an `[Ignore]` backing field.**
//    Signum's getter folds in `IsNew` (a new row is freely editable, which is what makes constructing one
//    possible at all); altea has no property getters in the entity model, so that half is written at the
//    single place that asks — `assertImmutable` below, `!entity.isNew && !entity.allowChange`. The field is
//    `@column(false)`: not a column (Signum's backing field is `[Ignore]` too), and therefore also outside
//    change tracking, so ALLOWING a change is not itself a change.
//    It is a real PROPERTY ROUTE, as Signum's `AllowChange` property is — `File.AllowChange`, which a
//    Signum database has a property-authorization rule for. Being a route means being serialized (altea's
//    route generation skips `@serialize(false)` members), so it rides the wire exactly as Signum's does:
//    a client that posts `allowChange: true` alongside modified bytes gets the same answer from either
//    framework. The gate on that is property-write authorization, which is what the route is for.
//  - **the process-wide `Disable()` is NOT ported.** Signum backs it with a `Statics.ThreadVariable`; this
//    layer is isomorphic and ships no node types, and a plain module-level flag on a server would be
//    shared by every concurrent request — the race `Connector.CurrentLogger` already documents. Nothing
//    is given up: all three of Signum's own callers are per-INSTANCE (`file.AllowChanges()`,
//    `file.AllowChange = true`, all in WordTemplateLogic), and `AllowChanges` IS ported below, where a
//    per-instance flag is safe by construction.
//
// The `PreSaving` half is registered by `SchemaBuilder.include` for every included subclass, which is
// where altea puts what Signum writes as an entity-level override (the accommodation altea-workflow's
// header records). Doing it there rather than in each module's logic means a subclass gets the guarantee
// from the base, as it does in Signum, instead of from remembering to hang a handler.

@reflect
export abstract class ImmutableEntity extends Entity {
    /**
     * Signum's `AllowChange` — lift the immutability for this instance. A NEW entity is editable
     * regardless (Signum folds `IsNew` into the getter; see `assertImmutable`).
     *
     * `@column(false)`, so it is neither a column nor part of the change diff — setting it cannot make
     * the entity look modified.
     */
    @column(false)
    allowChange: boolean = false;

    /**
     * Signum's `AllowChanges()` — set {@link allowChange} for the duration of a scope, restoring the
     * previous value on exit. Designed for a `using` declaration:
     * `using _ = file.allowChanges(); file.binaryFile = bytes; await file.save();`
     */
    allowChanges(): Disposable {
        const old = this.allowChange;
        this.allowChange = true;
        return { [Symbol.dispose]: () => { this.allowChange = old; } };
    }
}

/**
 * Signum's `ImmutableEntity.PreSaving`: refuse to save a stored instance whose own row changed.
 *
 * Registered on `entityEvents(T).preSaving` by {@link SchemaBuilder.include} for every included
 * ImmutableEntity subclass. Re-saving an UNCHANGED instance still works, which it has to — an owner's
 * save walks the whole reachable graph, so every owner of a shared file re-saves it.
 */
export function assertImmutable(entity: ImmutableEntity): void {
    if (entity.isNew || entity.allowChange)
        return;

    if (entity.isModifiedSelf())
        throw new Error(`Attempt to save a not new modified ${entity.getType().name} (${entity.id}): the row `
            + `is immutable, because it may be referenced by several owners. Assign a NEW instance to the `
            + `field instead of changing this one, or use allowChanges() if the change is deliberate.`);
}
