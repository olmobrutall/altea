import { AsyncLocalStorage } from "node:async_hooks";
import "@altea/altea/server";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import "@altea/altea/server/operationFluentInclude";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { Schema } from "@altea/altea/server/schema/schema";
import type { Query } from "@altea/altea/server/query";
import { table } from "@altea/altea/server/table";
import { Entity, type Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { Quoted } from "quote-transformer/quoted";
import { ConstantExpression, Expression, LambdaExpression, ObjectExpression } from "@altea/altea/server/linq/expressions";
import type { RuntimeType } from "@altea/altea/server/runtimeTypes";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { OperationLogic } from "@altea/altea/server/operationLogic";
import { UserWithClaims } from "@altea/altea/data/security";
import { UserHolder } from "@altea/altea/server/userHolder";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { EnumEntity } from "@altea/altea/data/enumEntity";
import { Symbol as EntitySymbol } from "@altea/altea/data/symbol";
import { NotNullValidator } from "@altea/altea/data/validators";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { TableIndex } from "@altea/altea/server/schema/tableIndex";
import { FieldImplementedBy, FieldReference } from "@altea/altea/server/schema/field";
import {
    Isolation, IsolationEntity, IsolationMessage, IsolationMixin, IsolationOperation,
    type IsolationStrategy,
} from "../data/Isolation";

// Port of Signum.Isolation's IsolationLogic.cs — multi-tenancy by row. Every table declares a STRATEGY
// (`Isolated` / `Optional` / `None`, registered on both tiers via `Isolation.register`), an isolated table
// gains the isolation column, and a request that has picked one sees only its rows: the filter is a WHERE
// the LINQ binder splices onto every query of that type, so retrieve, dynamic query and navigation are all
// covered by one registration.
//
// altea divergences:
//  - **the ambient current-isolation is SCOPE-shaped.** Signum's `IsolationEntity.Current` is an
//    AsyncThreadVariable that `UnsafeOverride` sets and an IDisposable restores; an AsyncLocalStorage
//    cannot be entered without a callback, so `override` / `disable` / `unsafeOverride` take the work as a
//    function — the same shape every other altea ambient has (`ExecutionMode.global`,
//    `UserHolder.withUser`, `CultureInfo.withCultures`). Signum's call sites are already `using` blocks, so
//    this is the same scope written differently.
//  - **the ambient lives HERE, not on the entity.** Signum puts `Current` on IsolationEntity, in its shared
//    assembly; altea's data layer is isomorphic and ships no node types.
//  - **the strategy table is in the DATA layer** (`Isolation.register`) — see data/Isolation.ts: altea
//    inlines a mixin's fields onto its owner, so the client must know which types carry `isolation` in
//    order to deserialize it.
//  - **`[AttachToUniqueIndexes]` and `[ForceNotNullable]` are applied here**, not as decorators. Signum has
//    two general field attributes with exactly one user between them (this mixin's field), so rather than
//    add two decorators to core, `start` rewrites the unique indexes of every isolated table on
//    `schemaCompleted` — which is where Signum applies the first one too (GenerateAllIndexes).
//  - **the operation scope is `OperationLogic.aroundOperation`**, the scoping half of Signum's one
//    `SurroundOperation` (see that seam's comment: altea's observing half must not break what it observes,
//    which is the wrong contract for a security scope).
//  - `Schema.AttachToUniqueFilter` is NOT ported. Its only Signum consumer is
//    `Table.DeclarePrimaryKeyVariable`, which resolves an entity's id BY ITS UNIQUE KEY inside a generated
//    migration script; altea's sync writes no such lookup, so there is nothing to scope.
export namespace IsolationLogic {

    /** Signum's `IsolationLogic.IsStarted`. */
    export let isStarted = false;

    /** Signum's `IsolationLogic.Isolations` — every isolation, cached (invalidated when one is saved). */
    export let isolations: ResetLazy<Lite<IsolationEntity>[]> = null!;

    // ---- the ambient current isolation ---------------------------------------------------------------
    //
    // A MUTABLE BOX in an AsyncLocalStorage, the pattern UserHolder uses: `withScope` opens one per request
    // (or per unit of background work) and the override helpers replace it for their inner scope. Outside
    // any scope the current isolation is null, which is Signum's "no override" — global mode.
    interface IsolationBox { value: Lite<IsolationEntity> | null; }

    const storage = new AsyncLocalStorage<IsolationBox>();

    /** Signum's `IsolationEntity.Current`. Null means GLOBAL mode: no isolation filter applies. */
    export function current(): Lite<IsolationEntity> | null {
        return storage.getStore()?.value ?? null;
    }

    /**
     * Signum's `IsolationEntity.UnsafeOverride(isolation)` — run `fn` with `isolation` current, whatever was
     * current before. Prefer {@link override}, which refuses to CHANGE an established isolation.
     */
    export function unsafeOverride<R>(isolation: Lite<IsolationEntity> | null, fn: () => R): R {
        return storage.run({ value: isolation }, fn);
    }

    /** Signum's `IsolationEntity.Disable()` — run `fn` in global mode. */
    export function disable<R>(fn: () => R): R {
        return unsafeOverride(null, fn);
    }

    /**
     * Signum's `IsolationEntity.Override(isolation)`: adopt `isolation` if none is current, keep going if it
     * is already the current one, and THROW if it would change it — crossing tenants mid-unit-of-work is a
     * bug, not something to allow silently. A null isolation is "nothing to adopt" and runs `fn` unchanged.
     */
    export function override<R>(isolation: Lite<IsolationEntity> | null, fn: () => R): R {
        if (isolation == null)
            return fn();

        const curr = current();
        if (curr != null) {
            if (curr.is(isolation))
                return fn();
            throw new Error(`Trying to change isolation from ${curr.toString()} to ${isolation.toString()}`);
        }

        return unsafeOverride(isolation, fn);
    }

    /**
     * Open a fresh ambient scope, starting in global mode — what the request middleware and a background
     * runner wrap their work in. Without it `override` still works (it opens its own), but a nested
     * `unsafeOverride` could not be undone by the caller.
     */
    export function withScope<R>(fn: () => R): R {
        return storage.run({ value: null }, fn);
    }

    /** The claim key the user's own isolation travels under (Signum's `"Isolation"`). */
    export const isolationClaim = "Isolation";

    /** Signum's `IsolationEntity.CurrentUserIsolation` — the isolation the CURRENT USER is pinned to. */
    export function currentUserIsolation(): Lite<IsolationEntity> | null {
        return (UserHolder.current()?.getClaim(isolationClaim) as Lite<IsolationEntity> | null | undefined) ?? null;
    }

    // ---- start ---------------------------------------------------------------------------------------

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // Signum's `ExecutionMode.OnSetIsolation`: background work adopts the isolation of the row it is
        // processing (the process runner, the scheduled-task runner, the two model renderers).
        ExecutionMode.onSetIsolation.push((candidates, fn) => {
            // Signum's `SetIsolation(a) ?? SetIsolation(b)`: the FIRST candidate that actually has one.
            for (const c of candidates) {
                const iso = Isolation.tryIsolation(c);
                if (iso != null)
                    return override(iso, fn);
            }
            return fn();
        });

        sb.include(IsolationEntity)
            .withSave(IsolationOperation.Save)
            .withQuery();

        // Signum's `UserWithClaims.FillClaims`: a user may itself be isolated, and then it can never leave
        // that isolation — the picker is not even offered (see IsolationServer).
        UserWithClaims.fillClaims.push((uwc, user) => {
            uwc.claims[isolationClaim] = Isolation.tryIsolation(user as unknown as Entity);
        });

        // Signum's `OperationLogic.SurroundOperation`, whose scoping half altea keeps separate.
        OperationLogic.aroundOperation.push((ctx, fn) => {
            const fromEntity = ctx.entity == null ? null : Isolation.tryIsolation(ctx.entity);
            // Signum's `args.TryGetArgC<Lite<IsolationEntity>>()`: a Construct has no entity, so the
            // isolation to run in may be passed as an argument instead.
            const fromArgs = fromEntity != null ? null
                : (ctx.args.find(a => isIsolationLite(a)) as Lite<IsolationEntity> | undefined) ?? null;
            return override(fromEntity ?? fromArgs, fn);
        });

        isolations = sb.globalLazy(
            async () => await table(IsolationEntity).map(i => i.toLite()).toArray(),
            { invalidateWith: [IsolationEntity] });

        // Signum's `Schema.SchemaCompleted += AssertIsolationStrategies`, which is also where every
        // per-type hook is installed: the set of tables is only final once every module has run its
        // includes, and so is the set of registered strategies.
        sb.schema.schemaCompleted.push(assertIsolationStrategies);

        isStarted = true;
    }

    function isIsolationLite(value: unknown): boolean {
        return value != null && typeof value === "object" && "entityType" in value
            && (value as Lite<Entity>).entityType === (IsolationEntity as unknown as Type<Entity>);
    }

    // ---- the strategy assertion, and everything it wires up ------------------------------------------

    /**
     * Signum's `AssertIsolationStrategies`: EVERY table in the schema must have declared a strategy, and
     * nothing may declare one that is not a table. It is a hard startup failure with a copy-pasteable list,
     * because the alternative — a type silently falling through as un-isolated — leaks rows across tenants.
     *
     * The "referenced by" hints Signum computes for the message are kept: they are what makes the list
     * actionable, since a type's strategy is usually decided by what points at it. Enum and symbol tables
     * are exempt on both sides, as is IsolationEntity itself.
     */
    function assertIsolationStrategies(schema: Schema): void {
        const declared = Isolation.allStrategies();
        const tables = [...schema.tables.values()]
            .map(t => t.type as Function)
            .filter(t => !isExempt(t));

        const tableSet = new Set(tables);
        const missing = tables.filter(t => !declared.has(t));
        const extra = [...declared.keys()].filter(t => !tableSet.has(t));

        if (missing.length > 0 || extra.length > 0) {
            const referencedBy = referencesOf(schema, new Set([...missing, ...extra]));
            const line = (t: Function): string => {
                const refs = referencedBy.get(t);
                return `  Isolation.register(${t.name}, "XXX");`
                    + (refs != undefined && refs.length > 0 ? ` // referenced by: ${refs.join(", ")}` : "");
            };
            throw new Error("Isolation strategies are not synchronized with the Schema.\n"
                + (extra.length > 0 ? `Remove something like:\n${extra.map(line).join("\n")}\n\n` : "")
                + (missing.length > 0 ? `Add something like:\n${missing.map(line).join("\n")}\n\n` : ""));
        }

        for (const [ctor, strategy] of declared) {
            if (strategy === "None")
                continue;
            registerFilterQuery(schema, ctor as Type<Entity>, strategy);
            attachIsolationToUniqueIndexes(schema, ctor as Type<Entity>);
            registerPreSaving(schema, ctor as Type<Entity>);
            registerRequiredValidator(ctor as Type<Entity>, strategy);
        }

        // Signum's filter on IsolationEntity itself: inside an isolation you see only YOUR isolation row.
        schema.entityEvents(IsolationEntity).queryFilter.push(ctx => {
            const curr = current();
            if (curr == null || ExecutionMode.isInGlobal())
                return undefined;
            return lambdaOf(isolationRowPredicate(curr), ctx.elementType);
        });
    }

    // Signum's `!a.IsEnumEntityOrSymbol() && !typeof(SemiSymbol)… && a != typeof(IsolationEntity)`. An enum
    // or symbol table is DECLARED, not application data: its rows are identical in every isolation.
    function isExempt(ctor: Function): boolean {
        return ctor === (IsolationEntity as unknown as Function)
            || isSubclassOf(ctor, EnumEntity) || isSubclassOf(ctor, EntitySymbol);
    }

    function isSubclassOf(ctor: Function, base: Function): boolean {
        for (let p: Function | null = ctor; p != null; p = Object.getPrototypeOf(p) as Function | null)
            if (p === base)
                return true;
        return false;
    }

    /** The `Type.field` sites pointing at each of `types` (Signum's `referencedBy` hint). */
    function referencesOf(schema: Schema, types: Set<Function>): Map<Function, string[]> {
        const result = new Map<Function, string[]>();
        const add = (target: Function, info: string): void => {
            if (!types.has(target))
                return;
            const list = result.get(target);
            if (list == undefined) result.set(target, [info]); else list.push(info);
        };
        for (const tab of schema.tables.values()) {
            for (const [name, field] of Object.entries(tab.fields)) {
                for (const target of referencedTypesOf(field.field))
                    add(target, `${(tab.type as Function).name}.${name}`);
            }
        }
        return result;
    }

    // A field's referenced entity types: one for a plain reference, several for an @implementedBy. Read off
    // the BUILT field, so it sees exactly what the schema has (Signum reads FieldReference.FieldType /
    // FieldImplementedBy.ImplementationColumns). An @implementedByAll names no type and contributes none —
    // Signum's walk has no branch for it either.
    function referencedTypesOf(field: unknown): Function[] {
        if (field instanceof FieldReference)
            return [field.column.referenceTable!.type as Function];
        if (field instanceof FieldImplementedBy)
            return field.implementationColumns.map(c => c.referenceTable!.type as Function);
        return [];
    }

    // ---- the row filter ------------------------------------------------------------------------------

    // Signum's `Register_FilterQuery<T>`: the WHERE the binder splices onto every query of T. Synchronous,
    // like every queryFilter hook — it reads the ambient isolation, never the database.
    function registerFilterQuery(schema: Schema, ctor: Type<Entity>, strategy: IsolationStrategy): void {
        schema.entityEvents(ctor).queryFilter.push(ctx => {
            const curr = current();
            if (curr == null || ExecutionMode.isInGlobal())
                return undefined;
            return lambdaOf(strategy === "Isolated" ? isolatedPredicate(curr) : optionalPredicate(curr), ctx.elementType);
        });

        // Signum's `PreUnsafeInsert`: a set-based INSERT builds its rows from a projection, so it never
        // goes through the save pipeline and would leave the column null. The constructor lambda is
        // rewritten to carry the current isolation — altea flattens mixin fields onto the owner, so this is
        // one more member on the projected object rather than Signum's `SetMixin` call wrapper.
        schema.entityEvents(ctor).preUnsafeInsert.push((_query: Query<Entity>, constructor: LambdaExpression) => {
            const curr = current();
            if (curr == null || ExecutionMode.isInGlobal())
                return undefined;
            if (!(constructor.body instanceof ObjectExpression))
                return undefined; // not a row projection — nothing to stamp (Signum's MList-table branch)
            if (isolationField in constructor.body.properties)
                return undefined; // the caller set it explicitly; leave it alone
            const withIsolation = new ObjectExpression(
                { ...constructor.body.properties, [isolationField]: new ConstantExpression(curr) },
                constructor.body.ctor);
            return new LambdaExpression(constructor.parameters, withIsolation);
        });
    }

    const isolationField = "isolation";

    // The three predicates, as quoted lambdas so the transformer stamps their trees. `curr` is a free
    // identifier, which the transformer captures BY VALUE where the lambda literal is evaluated — i.e. per
    // query, with whatever is ambient then.
    function isolatedPredicate(curr: Lite<IsolationEntity>): Quoted<(e: IsolationMixin) => boolean> {
        return (e: IsolationMixin) => e.isolation!.is(curr);
    }
    function optionalPredicate(curr: Lite<IsolationEntity>): Quoted<(e: IsolationMixin) => boolean> {
        return (e: IsolationMixin) => e.isolation!.is(curr) || e.isolation == null;
    }
    function isolationRowPredicate(curr: Lite<IsolationEntity>): Quoted<(e: IsolationEntity) => boolean> {
        return (e: IsolationEntity) => e.toLite().is(curr);
    }

    // Re-type a quoted predicate's parameter as the queried element type: the body only reads the flattened
    // `isolation` member, which every registered type has.
    function lambdaOf(predicate: unknown, elementType: RuntimeType): LambdaExpression {
        return Expression.fromQuotedLambda(predicate as Quoted<(e: never) => boolean>, [elementType]);
    }

    // ---- save-time enforcement ------------------------------------------------------------------------

    /**
     * Signum's `EntityEventsGlobal_PreSaving`: stamp a new row with the current isolation, and refuse to
     * save a row that belongs to a different one.
     *
     * ALTEA: per type rather than global (altea has no `EntityEventsGlobal`), so it is attached only to the
     * types that are actually isolated instead of testing the strategy on every save of every type.
     * Signum's `ctx.InvalidateGraph()` has no counterpart — altea's saver walks the graph it already built,
     * and the field written here is on an entity already in it.
     */
    function registerPreSaving(schema: Schema, ctor: Type<Entity>): void {
        schema.entityEvents(ctor).preSaving.push(entity => {
            const curr = current();
            if (curr == null)
                return;

            const own = Isolation.tryIsolation(entity);
            if (own == null) {
                if (entity.isNew)
                    Isolation.setIsolation(entity, curr);
                else if (entity.isDirty())
                    throw new Error(IsolationMessage.Entity0HasIsolation1ButCurrentIsolationIs2
                        .niceToString(entity.toString(), "null", curr.toString()));
            } else if (!own.is(curr)) {
                throw new Error(IsolationMessage.Entity0HasIsolation1ButCurrentIsolationIs2
                    .niceToString(entity.toString(), own.toString(), curr.toString()));
            }
        });
    }

    /**
     * Signum's `Validator.OverridePropertyValidator((IsolationMixin m) => m.Isolation).StaticPropertyValidation`,
     * plus its `ForceNotNullable` removal for `Optional`: an `Isolated` type REQUIRES the field, an
     * `Optional` one allows a global row. altea has no per-route validator override, but
     * `FieldInfo.validators` is a plain array — so the validator is pushed onto the OWNER's own route (the
     * mixin field is flattened onto it).
     */
    function registerRequiredValidator(ctor: Type<Entity>, strategy: IsolationStrategy): void {
        if (strategy !== "Isolated")
            return;

        // Through the MIXIN step: altea keeps mixin fields flat on the row, but a PropertyRoute still models
        // the mixin, so the field only resolves off `addMixin` (the same accommodation @altea/altea-diff-log
        // documents for its client routes).
        const fi = PropertyRoute.root(ctor).addMixin(IsolationMixin.name).addMember(isolationField).fieldInfo;
        if (fi == null)
            throw new Error(`Isolation: '${ctor.name}' is registered Isolated but has no '${isolationField}' member — was Isolation.register called on both tiers?`);

        // `NotNullValidator` IS Signum's check here — its message is the same `_0IsNotSet`.
        fi.validators.push(new NotNullValidator());
    }

    // ---- unique indexes -----------------------------------------------------------------------------

    /**
     * Signum's `[AttachToUniqueIndexes]`: a unique index on an isolated table is unique PER ISOLATION — two
     * tenants may each have their own "Default" row. Applied at `schemaCompleted`, which is where Signum
     * applies it too (GenerateAllIndexes).
     *
     * Signum's `AvoidAttachToUniqueIndexes` opt-out is not ported: altea's TableIndex has no such option
     * and nothing in the workspace would set it.
     */
    function attachIsolationToUniqueIndexes(schema: Schema, ctor: Type<Entity>): void {
        const tab = schema.tryTable(ctor);
        if (tab == null)
            return;

        const columns = tab.columnsFromFields([isolationField]);
        if (columns.length === 0)
            return;

        tab.indexes = tab.indexes.map(ix => {
            if (!ix.unique || ix.columns.some(c => columns.includes(c)))
                return ix;
            return new TableIndex(tab, [...ix.columns, ...columns],
                { unique: true, includeColumns: ix.includeColumns, where: ix.where });
        });
    }

    // ---- the helpers a caller uses -------------------------------------------------------------------

    /** Signum's `WhereCurrentIsolationInMemory`. */
    export function whereCurrentIsolationInMemory<T extends Entity>(collection: T[]): T[] {
        const curr = current();
        if (curr == null)
            return collection;
        return collection.filter(e => Isolation.tryStrategy(e.constructor) === "None"
            || Isolation.tryIsolation(e)?.is(curr) === true);
    }

    /**
     * Signum's `GetOnlyIsolation(selectedEntities)`: the ONE isolation every selected row shares, or null
     * when they disagree (or none of their types is isolated). What a contextual multi-operation asks
     * before deciding whether it can run at all.
     */
    export async function getOnlyIsolation(lites: Lite<Entity>[]): Promise<Lite<IsolationEntity> | null> {
        const byType = new Map<Type<Entity>, Lite<Entity>[]>();
        for (const lite of lites) {
            const list = byType.get(lite.entityType);
            if (list == undefined) byType.set(lite.entityType, [lite]); else list.push(lite);
        }

        const found: Lite<IsolationEntity>[] = [];
        for (const [ctor, group] of byType) {
            if (Isolation.tryStrategy(ctor) === "None")
                continue;
            const only = await onlyIsolationOf(ctor, group);
            if (only != null)
                found.push(only);
        }

        return only(found);
    }

    async function onlyIsolationOf(ctor: Type<Entity>, lites: Lite<Entity>[]): Promise<Lite<IsolationEntity> | null> {
        const found: Lite<IsolationEntity>[] = [];
        // Signum chunks by 100, so the generated `IN (…)` list stays reasonable.
        for (let i = 0; i < lites.length; i += 100) {
            const ids = lites.slice(i, i + 100).map(l => l.id!);
            const rows = await table(ctor).filter(e => ids.includes(e.id)).toArray() as Entity[];
            for (const row of rows) {
                const iso = Isolation.tryIsolation(row);
                if (iso != null)
                    found.push(iso);
            }
        }
        return only(found);
    }

    /** Signum's `.Only()` over lites: the single distinct one, else null. */
    function only(lites: Lite<IsolationEntity>[]): Lite<IsolationEntity> | null {
        const distinct = [...new Map(lites.map(l => [l.key(), l])).values()];
        return distinct.length === 1 ? distinct[0] : null;
    }
}
