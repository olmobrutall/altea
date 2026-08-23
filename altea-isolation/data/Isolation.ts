import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, MixinEntity, type Type } from "@altea/altea/data/entity";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { entity, quoted, stringLengthValidator, uniqueIndex } from "@altea/altea/data/decorators";
import type { Lite } from "@altea/altea/data/lite";
import type { ExecuteSymbol } from "@altea/altea/data/operations";
import { msg } from "@altea/altea/data/utils/localization";

// Port of Signum.Isolation's IsolationEntity.cs — multi-tenancy by row: every isolated table carries the
// tenant its rows belong to, and a request that has picked one sees only those rows.
//
// One structural divergence shapes this file, and it is the reason the strategy table lives HERE rather
// than in the logic layer as Signum's does: **altea inlines a mixin's fields onto its owner**, so the
// client has to know a type carries the mixin in order to deserialize the `isolation` field at all —
// where Signum's client reads a separately-serialized mixin bag. `Isolation.register(T, strategy)` is
// therefore an ISOMORPHIC call the app makes from its shared entity-overrides module (the same place
// @altea/altea-diff-log's `DiffLogMixin.declare()` goes), and the server's `IsolationLogic.start` reads
// the map back. Signum's `IsolationLogic.Register<T>` is server-only and declares the mixin itself.
@reflect
@entity("String", "Master", { lowPopulation: true })
export class IsolationEntity extends Entity {
    @uniqueIndex
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    @quoted toString(): string { return this.name; }
}

export namespace IsolationOperation {
    export const Save: ExecuteSymbol<IsolationEntity> = init();
}

/**
 * How one entity type relates to isolation (Signum's `IsolationStrategy`):
 *  - `Isolated`: every row belongs to exactly one isolation, and the field is required.
 *  - `Optional`: a row may be GLOBAL (isolation null) and is then visible from every isolation.
 *  - `None`: the type is not isolated at all — it carries no mixin and no filter.
 *
 * ALTEA: a plain string union rather than a reflected enum. Signum declares it `[InTypeScript(true)]` with
 * translatable members, but nothing translates it on either side — the only display is the schema map's
 * tooltip, which shows the raw name — and it is never a stored column, so it needs no enum table.
 */
export type IsolationStrategy = "Isolated" | "Optional" | "None";

export const IsolationMessage = {
    Entity0HasIsolation1ButCurrentIsolationIs2: msg("Entity {0} has isolation {1} but current isolation is {2}"),
    SelectAnIsolation: msg("Select an isolation"),
    Entity0HasIsolation1ButEntity2HasIsolation3: msg("Entity '{0}' has isolation {1} but entity '{2}' has isolation {3}"),
    GlobalMode: msg("Global mode"),
    GlobalEntity: msg("Global entity"),
};

/**
 * Signum's `IsolationMixin` — the one field an isolated type gains.
 *
 * ALTEA: Signum initializes it to `IsRetrieving ? null : IsolationEntity.Current`, which the DATA layer
 * cannot do here: the ambient current-isolation is an AsyncLocalStorage and so is server-only, while this
 * file is isomorphic. Nothing is lost — Signum ALSO stamps it in its global PreSaving handler, which is
 * what `IsolationLogic` does for every new row, and the client's widget reads the picked isolation from
 * `IsolationClient` rather than from the field.
 *
 * Signum's `[AttachToUniqueIndexes]` and `[ForceNotNullable]` have no altea decorators; both are applied
 * from `IsolationLogic.start` instead, on the one type that needs them — see there.
 */
@reflect
export class IsolationMixin extends MixinEntity {
    isolation: Lite<IsolationEntity> | null;
}

// The strategy table, and the mixin declaration that goes with it. Isomorphic on purpose (see the file
// header): both tiers must agree on which types carry the field.
const strategies = new Map<Function, IsolationStrategy>();

export namespace Isolation {

    /**
     * Signum's `IsolationLogic.Register<T>(strategy)`: declare how T relates to isolation. `Isolated` and
     * `Optional` also declare the mixin on T, so the field exists on both tiers.
     *
     * Call it from the module BOTH tiers load (the app's entity-overrides), before anything is
     * (de)serialized or the schema is built. Registering the same type twice with the same strategy is a
     * no-op, so an app may call its overrides module more than once; a CONFLICTING strategy throws.
     */
    export function register<T extends Entity>(type: Type<T>, strategy: IsolationStrategy): void {
        const previous = strategies.get(type);
        if (previous != undefined) {
            if (previous !== strategy)
                throw new Error(`Isolation strategy for '${type.name}' is already registered as ${previous}, cannot change it to ${strategy}`);
            return;
        }

        strategies.set(type, strategy);

        if (strategy !== "None")
            MixinDeclarations.register(type as unknown as Type<Entity>, IsolationMixin as unknown as Type<IsolationMixin>);
    }

    /** Signum's `IsolationLogic.GetStrategy(type)` — throws for an unregistered type, as Signum's does. */
    export function strategy(type: Function): IsolationStrategy {
        const s = strategies.get(type);
        if (s == undefined)
            throw new Error(`No isolation strategy registered for '${type.name}'. Register every entity type with Isolation.register(...)`);
        return s;
    }

    /** Signum's `strategies.TryGet(type, IsolationStrategy.None)`. */
    export function tryStrategy(type: Function): IsolationStrategy {
        return strategies.get(type) ?? "None";
    }

    /** Signum's `IsolationLogic.GetIsolationStrategies()` — a copy, keyed by ctor. */
    export function allStrategies(): Map<Function, IsolationStrategy> {
        return new Map(strategies);
    }

    /**
     * Signum's `IsolationExtensions.TryIsolation(entity)`: the entity's isolation, or null when its type
     * does not carry the mixin. Safe on any entity.
     */
    export function tryIsolation(entity: Entity): Lite<IsolationEntity> | null {
        if (tryStrategy(entity.constructor) === "None")
            return null;
        return (entity as unknown as IsolationMixin).isolation ?? null;
    }

    /** Signum's `IsolationExtensions.SetIsolation(entity, isolation)` — returns the entity, for chaining. */
    export function setIsolation<T extends Entity>(entity: T, isolation: Lite<IsolationEntity> | null): T {
        (entity as unknown as IsolationMixin).isolation = isolation;
        return entity;
    }
}

/**
 * Signum's `IsolationExtensions.Isolation(this IEntity)` — the QUERY form, `[AutoExpressionField]` over the
 * mixin field. altea flattens a mixin onto its owner, so the member is a plain field read; declared as a
 * standalone `@quoted` helper because a mixin cannot add a method to every owner.
 *
 * Only valid inside a query on a type registered `Isolated` or `Optional`.
 */
export function isolationOf(entity: Entity): Lite<IsolationEntity> | null {
    return (entity as unknown as IsolationMixin).isolation ?? null;
}
