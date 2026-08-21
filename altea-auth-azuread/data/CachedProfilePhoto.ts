import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, unit, quoted } from "@altea/altea/data/decorators";
import { fieldValidation } from "@altea/altea/data/decorators";
import { ValidationMessage } from "@altea/altea/data/validators";
import { Temporal, type int } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { UserEntity } from "@altea/altea-auth/data/User";
import { FilePathEmbedded, FileTypeSymbol } from "@altea/altea-files/data/Files";

// Port of Signum.Authorization.AzureAD's CachedProfilePhoto.cs — a locally stored copy of a user's Microsoft
// Graph photo, so a page full of avatars does not become a page full of Graph calls.
//
// altea divergences, documented inline:
//  - `[DefaultFileType(nameof(AuthADFileType.CachedProfilePhoto))]` has no altea counterpart (altea-files
//    ships no per-property file-type metadata), so the file type is passed when the FilePathEmbedded is
//    constructed — see CachedProfilePhotoLogic.
//  - `[NumberIsValidator(ComparisonType.GreaterThan, 0)]` + the `PropertyValidation` that pins the size to
//    one of Graph's supported sizes collapse into ONE `@fieldValidation` (altea has no number validator and
//    no entity-level validation hook).
//  - `CreationDate { get; private set; } = Clock.Now` → a plain field with the same initializer (altea has
//    no private setters).

/** Graph serves photos at these square sizes only (Signum's `AzureADLogic.ToAzureSize`). */
export const azureImageSizes = [48, 64, 96, 120, 240, 360, 432, 504, 648] as const;

/** Signum's `AzureADLogic.ToAzureSize` — round a requested size UP to a size Graph actually serves. */
export function toAzureSize(size: number): number {
    return azureImageSizes.find(s => size <= s) ?? 648;
}

@reflect
@entity("System", "Transactional")
export class CachedProfilePhotoEntity extends Entity {
    user: Lite<UserEntity>;

    @unit("px")
    @fieldValidation<CachedProfilePhotoEntity>(p => {
        const size = p.size as unknown as number;
        if (!(size > 0))
            return ValidationMessage.NumberIsTooSmall.niceToString();
        return size !== toAzureSize(size)
            ? ValidationMessage._0ShouldBe1.niceToString("Size", toAzureSize(size))
            : null;
    })
    size: int;

    photo: FilePathEmbedded | null = null;

    /** When the copy stops being trusted and Graph is asked again. */
    invalidationDate: Temporal.PlainDateTime;

    creationDate: Temporal.PlainDateTime = Clock.now;

    // Signum's `As.Expression(() => $"{User} {Size}px")`. Written as plain concatenation, NOT a template
    // literal, and with no `?? ""`: `user` is non-nullable, and both of those introduce an EMPTY-STRING
    // constant into the lowered SQL. The parameter builder reuses one placeholder per distinct value, so a
    // second `""` would land both as a bare `$1 AS c0` in the select list (untypable in Postgres) and inside
    // a `COALESCE(u.user_name, $1)` (varchar) — which Postgres rejects with "inconsistent types deduced for
    // parameter $1".
    @quoted
    toString(): string {
        return this.user.toString() + " " + this.size + "px";
    }
}

/** Signum's `[AutoInit] static class CachedProfilePhotoOperation`. */
export namespace CachedProfilePhotoOperation {
    export const Save: ExecuteSymbol<CachedProfilePhotoEntity> = init();
    export const Delete: DeleteSymbol<CachedProfilePhotoEntity> = init();
}

/** Signum's `[AutoInit] static class AuthADFileType`. */
export namespace AuthADFileType {
    export const CachedProfilePhoto: FileTypeSymbol = init();
}

