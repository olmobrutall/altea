import { reflect, init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { CurrentUser } from "@altea/altea/data/security";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, part, uniqueIndex, backReference, valueField, quoted } from "@altea/altea/data/decorators";
import { stringLengthValidator, noRepeatValidator } from "@altea/altea/data/validators";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";

// Port of Signum.Authorization's RoleEntity.cs — see port/Auth.md.
//
// A role is the unit authorization
// rules attach to; users point at one role, and roles form a DAG via `inheritsFrom`.
//
// altea divergences, documented inline:
//  - `MList<Lite<RoleEntity>> InheritsFrom` → the altea MList replacement: a plain array of `@part` link
//    rows (RoleEntity_InheritsFrom), each `@backReference` to the owner + a `@valueField` holding the
//    inherited role's Lite. (The [BindParent, NoRepeatValidator] pair becomes the array + a server-side
//    de-dup check when authorization lands.)
//  - `RoleEntity.Current` / `RetrieveFromCache` are server-only (read UserHolder claims / the role
//    cache) — they live in AuthLogic, not on the isomorphic entity.
//  - `PreSaving` (trivial-merge name) and the trivial-merge `PropertyValidation` are authorization-admin
//    concerns; they land with the authorization phase (the Save operation computes the name server-side).

// A plain numeric entity enum, like OrderState (the proven
// pattern for entity enum fields that also feed the operation graph).
export enum MergeStrategy {
    Union,
    Intersection,
}

@reflect
@entity("Main", "Master")
export class RoleEntity extends Entity {
    @uniqueIndex
    @stringLengthValidator({ min: 2, max: 200 })
    name: string;

    mergeStrategy: MergeStrategy = MergeStrategy.Union;

    isTrivialMerge: boolean = false;

    @noRepeatValidator()
    inheritsFrom: RoleEntity_InheritsFrom[];

    @stringLengthValidator({ multiLine: true })
    description: string | null = null;

    @quoted
    toString(): string {
        return this.name;
    }

    /**
     * The role of the current login, off the "Role" claim (filled in
     * data/User.ts). Unlike Signum's, which is server-only, it answers on BOTH TIERS: the server resolves
     * the user from the request scope, the client from the logged-in user (see `CurrentUser` in altea's
     * data/security).
     *
     * It returns NULL when nobody is logged in, where Signum throws `AuthenticationException`.
     * altea's AuthenticationException is server-only (the data layer must stay isomorphic), and every
     * caller in the workspace null-checks anyway, so this answers null instead.
     */
    static current(): Lite<RoleEntity> | null {
        return CurrentUser.claim<Lite<RoleEntity>>("Role");
    }
}

// Link rows for RoleEntity.inheritsFrom.
@part
export class RoleEntity_InheritsFrom extends Entity {
    @backReference
    role: Lite<RoleEntity>;

    @valueField
    inheritsFrom: Lite<RoleEntity>;
}

export namespace RoleOperation {
    export const Save: ExecuteSymbol<RoleEntity> = init();
    export const Delete: DeleteSymbol<RoleEntity> = init();
}

// All altea-auth entities (this data/ folder: User, Role + link rows, the Rule* tables, PermissionSymbol,
// TypeConditionSymbol) live in an "auth" DB schema. FOLDER-scoped to @altea/altea-auth/data (the
// transformer stamps the __fileInfo); declared here in Role.ts because AuthLogic imports it before any
// auth table is included. Auth enums (e.g. UserState) resolve to this schema too, since they are defined
// in this package.
setDefaultDatabaseSchema("auth");
