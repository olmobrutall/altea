import type { Entity } from "./entity";
import type { Lite } from "./lite";

// Port of Signum's Signum/Security/IUserEntity.cs — the CORE (framework-level) auth contracts that the
// framework's own entities (ExceptionEntity, OperationLogEntity) and the downstream altea-auth
// UserEntity both depend on. Signum keeps these in Signum.Security (core) while the concrete UserEntity
// lives in the Signum.Authorization extension; altea mirrors that split so altea (core) never imports
// altea-auth.
//
// altea divergences, documented inline:
//  - Signum's `IUserEntity : IEntity` marker becomes `interface IUserEntity extends Entity {}`. altea
//    has no IEntity interface (entities are the `Entity` CLASS); a marker interface that extends the
//    Entity class inherits its members, so `Lite<IUserEntity>` type-checks and any concrete UserEntity
//    (which extends Entity) is structurally assignable to it.
//  - `Statics.SessionVariable<UserWithClaims>` (Signum's session-scoped holder) → an async-scoped
//    context variable in server/userHolder.ts (the server equivalent). UserWithClaims itself is a plain
//    isomorphic value type shared by both ends.

/** Signum's IUserEntity marker (Signum/Security/IUserEntity.cs). */
export interface IUserEntity extends Entity { }

/** Signum's IEmailOwnerEntity marker (Signum/Mailing/…); the mailing module is not ported, so this is a
 *  bare marker for now — UserEntity implements it structurally. */
export interface IEmailOwnerEntity extends Entity { }

// Signum's UserWithClaims (IUserEntity.cs): the current user plus a bag of arbitrary claims (Role,
// Culture, ExternalId, …) filled by the FillClaims hook at login. The claims are read server-side by
// RoleEntity.Current / UserEntity.CurrentExternalId etc.
export type FillClaims = (uwc: UserWithClaims, user: IUserEntity) => void;

export class UserWithClaims {
    readonly user: Lite<IUserEntity>;
    readonly claims: Record<string, unknown>;

    // Signum's `static event Action<UserWithClaims, IUserEntity>? FillClaims` — modules push claim
    // fillers (e.g. AuthLogic adds "Role"/"Culture"). Ran once when a UserWithClaims is built from a
    // full user. Kept as an array so several modules can contribute (matching a multicast delegate).
    static fillClaims: FillClaims[] = [];

    constructor(user: Lite<IUserEntity>, claims: Record<string, unknown>);
    constructor(user: IUserEntity);
    constructor(userOrLite: IUserEntity | Lite<IUserEntity>, claims?: Record<string, unknown>) {
        if (claims != null) {
            this.user = userOrLite as Lite<IUserEntity>;
            this.claims = claims;
        } else {
            const user = userOrLite as IUserEntity;
            this.user = user.toLite() as Lite<IUserEntity>;
            this.claims = {};
            for (const fill of UserWithClaims.fillClaims)
                fill(this, user);
        }
    }

    getClaim(claimName: string): unknown {
        return this.claims[claimName];
    }
}
