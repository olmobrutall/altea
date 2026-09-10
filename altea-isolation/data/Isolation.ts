import { reflect, init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity, MixinEntity, type Type } from "@altea/altea/data/entity";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { entity, quoted, uniqueIndex } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import type { Lite } from "@altea/altea/data/lite";
import type { ExecuteSymbol } from "@altea/altea/data/operations";
import { msg } from "@altea/altea/data/utils/localization";

// Multi-tenancy by row: every isolated table carries the tenant its rows belong to, and a request that has
// picked one sees only those rows.
//
// The strategy table lives HERE, not in the logic layer, and that is load-bearing: a mixin's fields are
// INLINED onto its owner, so the client has to know a type carries the mixin in order to deserialize the
// `isolation` field at all. `Isolation.register(T, strategy)` is therefore an ISOMORPHIC call the app makes
// from its shared entity-overrides module (the same place @altea/altea-diff-log's `DiffLogMixin.declare()`
// goes), and the server's `IsolationLogic.start` reads the map back.
//
// Port of Signum.Isolation's IsolationEntity.cs — see docs/port/Isolation.md.
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
 * How one entity type relates to isolation:
 *  - `Isolated`: every row belongs to exactly one isolation, and the field is required.
 *  - `Optional`: a row may be GLOBAL (isolation null) and is then visible from every isolation.
 *  - `None`: the type is not isolated at all — it carries no mixin and no filter.
 *
 * A plain string union rather than a reflected enum: nothing translates it (the only display is the schema
 * map's tooltip, which shows the raw name) and it is never a stored column, so it needs no enum table.
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
 * The one field an isolated type gains.
 *
 * The current isolation is NOT stamped by a field initializer: the ambient is an AsyncLocalStorage and so
 * is server-only, while this file is isomorphic. `IsolationLogic` stamps it in its PreSaving handler for
 * every new row instead, and the client's widget reads the picked isolation from `IsolationClient` rather
 * than from the field.
 *
 * The unique-index rewrite and the required rule have no decorators here; both are applied
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
     * Declare how T relates to isolation. `Isolated` and
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
            MixinDeclarations.register(type, IsolationMixin);
    }

    /** THROWS for an unregistered type — a type quietly falling through as un-isolated is the worst
     *  thing this module could get wrong. */
    export function strategy(type: Function): IsolationStrategy {
        const s = strategies.get(type);
        if (s == undefined)
            throw new Error(`No isolation strategy registered for '${type.name}'. Register every entity type with Isolation.register(...)`);
        return s;
    }

    /** The strategy, or `None` for an unregistered type. */
    export function tryStrategy(type: Function): IsolationStrategy {
        return strategies.get(type) ?? "None";
    }

    /** A copy, keyed by ctor. */
    export function allStrategies(): Map<Function, IsolationStrategy> {
        return new Map(strategies);
    }

    /**
     * The entity's isolation, or null when its type
     * does not carry the mixin. Safe on any entity.
     */
    export function tryIsolation(entity: Entity): Lite<IsolationEntity> | null {
        if (tryStrategy(entity.constructor) === "None")
            return null;
        return (entity as unknown as IsolationMixin).isolation ?? null;
    }

    /** Returns the entity, for chaining. */
    export function setIsolation<T extends Entity>(entity: T, isolation: Lite<IsolationEntity> | null): T {
        (entity as unknown as IsolationMixin).isolation = isolation;
        return entity;
    }
}

/**
 * The QUERY form, `[AutoExpressionField]` over the
 * mixin field. altea flattens a mixin onto its owner, so the member is a plain field read; declared as a
 * standalone `@quoted` helper because a mixin cannot add a method to every owner.
 *
 * Only valid inside a query on a type registered `Isolated` or `Optional`.
 */
export function isolationOf(entity: Entity): Lite<IsolationEntity> | null {
    return (entity as unknown as IsolationMixin).isolation ?? null;
}

setDefaultDatabaseSchema("isolation");
