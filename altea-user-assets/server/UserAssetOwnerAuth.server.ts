import type { Type, Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { UserHolder } from "@altea/altea/server/userHolder";
import { TypeAllowedBasic } from "@altea/altea-auth/data/Rules";
import type { TypeConditionSymbol } from "@altea/altea-auth/data/Rules";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { TypeConditionLogic } from "@altea/altea-auth/server/TypeConditionLogic";
import { TypeAuthLogic } from "@altea/altea-auth/server/TypeAuthLogic";

// Port of the owner-scoping half of Signum's UserQueryLogic / UserChartLogic / DashboardLogic —
// `RegisterUserTypeCondition` / `RegisterRoleTypeCondition` plus the in-memory visibility filter their
// lookups apply (`Schema.Current.GetInMemoryFilter<T>(userInterface: false)`).
//
// altea divergences:
//  - Signum DUPLICATES these three methods per module (each closed over its own entity type). Every altea
//    user asset carries the SAME `owner: Lite<Entity> | null` field, so they live here ONCE and each module
//    re-exports a thin, Signum-named wrapper. The `@quoted` predicate is written once and bound per entity
//    type by the LINQ binder (the ctor is the registry key).
//  - Signum's `AssertImplementedBy(x => x.Owner, ownerType)` is dropped: an altea `@implementedBy` list is
//    declared on the field itself (data/UserQuery.ts etc. already name UserEntity + RoleEntity), so there is
//    nothing to assert at runtime.
//  - Signum ALSO mirrors each condition onto every child/part entity (`RegisterTypeConditionForPart<T>`,
//    TokenEquivalenceGroup, …). altea needs none of that: a Part inherits its owner's TypeAllowed AND
//    TypeConditions structurally, chaining to the non-Part root (altea-auth/server/PartOwnership.ts), and
//    TypeAuthLogic rebases the root's condition onto a standalone part query.
//  - The in-memory filter is `TypeAuthLogic.isAllowedFor` (async — it may need to fill DB-only conditions),
//    so `filterVisible` is async where Signum's predicate was sync.

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
     * Signum's `RegisterUserTypeCondition`: the asset belongs to the CURRENT USER.
     *
     * Registered with the same lambda for SQL and memory (`registerCompile`): `owner.is(lite)` lowers to the
     * `owner_id_user` column comparison (SmartEqualizer) and, in memory, is Lite's value equality — so both
     * paths agree. `UserHolder.currentUserLite()` takes no parameters, so the LINQ binder folds it to a
     * constant while building each query (Signum's `UserEntity.Current` in an expression tree).
     */
    export function registerUserTypeCondition<T extends IOwnedAssetEntity>(ctor: Type<T>, typeCondition: TypeConditionSymbol): void {
        TypeConditionLogic.registerCompile<T>(ctor, typeCondition,
            e => e.owner != null && e.owner.is(UserHolder.currentUserLite()));
    }

    /**
     * Signum's `RegisterRoleTypeCondition`: the asset is GLOBAL (no owner) or owned by one of the current
     * user's roles (its own role plus everything that role inherits from).
     *
     * Registered with an EXPLICIT in-memory predicate (`register`, not `registerCompile`): the SQL form uses
     * `array.includes(reference)` — which the binder lowers to Signum's EntityIn (an OR of id comparisons) —
     * but in JavaScript `Array.includes` is REFERENCE equality, which would silently never match. The
     * in-memory twin therefore compares with Lite's value equality instead.
     */
    export function registerRoleTypeCondition<T extends IOwnedAssetEntity>(ctor: Type<T>, typeCondition: TypeConditionSymbol): void {
        TypeConditionLogic.register<T>(ctor, typeCondition,
            e => e.owner == null || currentRoleOwners().includes(e.owner),
            e => e.owner == null || AuthLogic.currentRoles().some(r => r.is(e.owner)));
    }

    /**
     * Signum's `Schema.Current.GetInMemoryFilter<T>(userInterface: false)` applied to a cached list: keep only
     * the assets the current role may READ, evaluating the role's condition rules per instance.
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
