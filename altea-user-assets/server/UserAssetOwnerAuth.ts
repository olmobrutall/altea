import type { Type, Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { UserHolder } from "@altea/altea/server/userHolder";
import { TypeAllowedBasic } from "@altea/altea-auth/data/Rules";
import type { TypeConditionSymbol } from "@altea/altea-auth/data/Rules";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { TypeConditionLogic } from "@altea/altea-auth/server/TypeConditionLogic";
import { TypeAuthLogic } from "@altea/altea-auth/server/TypeAuthLogic";

// The owner-scoping half every user-asset module shares — see docs/port/UserAssets.md.
//
// `registerUserTypeCondition` / `registerRoleTypeCondition` plus the in-memory visibility filter their
// lookups apply. They live here ONCE, and each module re-exports a thin wrapper, because every user asset
// carries the SAME `owner: Lite<Entity> | null`: the `@quoted` predicate is written once and bound per
// entity type by the LINQ binder (the ctor is the registry key).

/** Any user asset that can be owned by a user or shared with a role (Dashboard / UserQuery / UserChart). */
export interface IOwnedAssetEntity extends Entity {
    owner: Lite<Entity> | null;
}

// `owner` is `@implementedBy([UserEntity, RoleEntity])`, i.e. `Lite<Entity>`, so the role set has to be
// widened to compare against it. The widening happens HERE, outside the `@quoted` predicate below: a cast
// inside a quoted lambda has no expression form (the transformer cannot quote it).
function currentRoleOwners(): Lite<Entity>[] {
    return AuthLogic.currentRoles() as unknown as Lite<Entity>[];
}

export namespace UserAssetOwnerAuth {

    /**
     * The asset belongs to the CURRENT USER.
     *
     * Registered with the same lambda for SQL and memory (`registerCompile`): `owner.is(lite)` lowers to the
     * `owner_id_user` column comparison (SmartEqualizer) and, in memory, is Lite's value equality — so both
     * paths agree. `UserHolder.currentUserLite()` takes no parameters, so the LINQ binder folds it to a
     * constant while building each query.
     */
    export function registerUserTypeCondition<T extends IOwnedAssetEntity>(ctor: Type<T>, typeCondition: TypeConditionSymbol): void {
        TypeConditionLogic.registerCompile<T>(ctor, typeCondition,
            e => e.owner != null && e.owner.is(UserHolder.currentUserLite()));
    }

    /**
     * The asset is GLOBAL (no owner) or owned by one of the current
     * user's roles (its own role plus everything that role inherits from).
     *
     * Registered with an EXPLICIT in-memory predicate (`register`, not `registerCompile`): the SQL form uses
     * `array.includes(reference)` — which the binder lowers to an OR of id comparisons — but in JavaScript
     * `Array.includes` is REFERENCE equality, which would silently never match. The in-memory twin
     * therefore compares with Lite's value equality instead.
     */
    export function registerRoleTypeCondition<T extends IOwnedAssetEntity>(ctor: Type<T>, typeCondition: TypeConditionSymbol): void {
        TypeConditionLogic.register<T>(ctor, typeCondition,
            e => e.owner == null || currentRoleOwners().includes(e.owner),
            e => e.owner == null || AuthLogic.currentRoles().some(r => r.is(e.owner)));
    }

    /**
     * Keep only the assets the current role may READ, evaluating the role's condition rules per instance.
     *
     * Needed because every asset module serves its lookups from a `globalLazy` cache, whose factory runs in
     * ExecutionMode.global — so the row-level query filter TypeAuthLogic installs never saw those reads.
     */
    export async function filterVisible<T extends Entity>(entities: readonly T[]): Promise<T[]> {
        if (entities.length === 0)
            return [];

        const allowed = await Promise.all(entities.map(e => TypeAuthLogic.isAllowedFor(e, TypeAllowedBasic.Read, false)));
        return entities.filter((_, i) => allowed[i]);
    }

    /** `filterVisible` for ONE entity — the shape a `retrieveX(id)` lookup needs. */
    export async function isVisible<T extends Entity>(entity: T): Promise<boolean> {
        return await TypeAuthLogic.isAllowedFor(entity, TypeAllowedBasic.Read, false);
    }
}
