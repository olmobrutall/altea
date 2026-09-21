import { init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, primaryKey, uniqueIndex, quoted } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";

// A LOCAL stand-in for a directory group,
// so an application entity can reference one (a dashboard's audience, a toolbar's visibility) without the
// database depending on Microsoft Graph being reachable.
//
// The primary key IS the group's own Entra object id, so an import writes the id it was given rather than
// `SetId(groupRequest.Id)` + `Administrator.SaveDisableIdentity`, so the row IS the directory group rather
// than a local copy of it. altea's `@primaryKey("uuid")` is the same thing (the shape @altea/altea-user-assets
// already uses for portable identities), and an explicitly-assigned uuid PK needs no identity juggling —
// letting the database assign one — which is why `ADGroupOperation.Save` below needs no identity dance.

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

/** The group's operations. */
export namespace ADGroupOperation {
    export const Save: ExecuteSymbol<ADGroupEntity> = init();
    export const Delete: DeleteSymbol<ADGroupEntity> = init();
}

/** The wire shape the client posts to `/api/createADGroup`. */
export interface ADGroupRequest {
    id: string;
    displayName: string;
}
