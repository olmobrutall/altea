import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, primaryKey, uniqueIndex, quoted, stringLengthValidator } from "@altea/altea/data/decorators";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";

// Port of Signum.Authorization.AzureAD's ADGroup/ADGroupEntity.cs — a LOCAL stand-in for a directory group,
// so an application entity can reference one (a dashboard's audience, a toolbar's visibility) without the
// database depending on Microsoft Graph being reachable.
//
// The primary key is the group's own Entra object id: Signum declares `[PrimaryKey(typeof(Guid))]` and then
// `SetId(groupRequest.Id)` + `Administrator.SaveDisableIdentity`, so the row IS the directory group rather
// than a local copy of it. altea's `@primaryKey("uuid")` is the same thing (the shape @altea/altea-user-assets
// already uses for portable identities), and an explicitly-assigned uuid PK needs no identity juggling —
// which is why `ADGroupOperation.Save` below has none of Signum's SaveDisableIdentity dance.

@reflect
@entity("String", "Master")
@primaryKey("uuid")
export class ADGroupEntity extends Entity {
    @uniqueIndex
    @stringLengthValidator({ max: 100 })
    displayName: string;

    @quoted
    toString(): string {
        return this.displayName;
    }
}

/** Signum's `[AutoInit] static class ADGroupOperation`. */
export namespace ADGroupOperation {
    export const Save: ExecuteSymbol<ADGroupEntity> = init();
    export const Delete: DeleteSymbol<ADGroupEntity> = init();
}

/** The wire shape the client posts to `/api/createADGroup` (Signum's ADGroupController.ADGroupRequest). */
export interface ADGroupRequest {
    id: string;
    displayName: string;
}
