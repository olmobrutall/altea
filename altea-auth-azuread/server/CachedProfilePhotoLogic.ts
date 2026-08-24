import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/fluentOperations"; // FluentInclude.withSave/.withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { Temporal, toInt } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { UserEntity } from "@altea/altea-auth/data/User";
import { FilePathEmbedded } from "@altea/altea-files/data/Files";
import { FileTypeLogic } from "@altea/altea-files/server/FileTypeLogic.server";
import { FilePathEmbeddedLogic } from "@altea/altea-files/server/FilePathEmbeddedLogic.server";
import type { IFileTypeAlgorithm } from "@altea/altea-files/server/FileTypeAlgorithm.server";
import {
    AuthADFileType, CachedProfilePhotoEntity, CachedProfilePhotoOperation, toAzureSize,
} from "../data/CachedProfilePhoto";
import { AzureADLogic } from "./AzureADLogic";

// Port of Signum.Authorization.AzureAD's CachedProfilePhotoLogic.cs — keep a local copy of each user's
// Microsoft Graph photo so a grid of avatars costs one Graph call per user per month, not per render.
//
// altea divergences, documented inline:
//  - `WithExpressionFrom((UserEntity u) => u.CachedProfilePhotos())` (a registered expression, so the photo
//    rows show as a widget on the user) is NOT ported: it needs an `@quoted` extension expression on
//    UserEntity registered from this module, which altea supports only for types the module owns. The rows
//    are still reachable through their own query.
//  - `new FilePathEmbedded(AuthADFileType.CachedProfilePhoto, name, bytes)` → construct + assign, since
//    altea-files has no per-property default file type (see data/CachedProfilePhoto.ts).
//  - `Clock.Now.AddDays / AddMonths` → `Clock.now.add({ days } / { months })`.

export namespace CachedProfilePhotoLogic {

    export let isStarted = false;

    /** Signum's `DefaultSize` — 22 px rounded up to a size Graph serves. */
    export const defaultSize = toAzureSize(22);

    /** Signum's `CalculateInvalidationDate` — a user WITH a photo is re-checked monthly, one without
     *  (much more common, and cheap to be wrong about) weekly. */
    export let calculateInvalidationDate: (p: CachedProfilePhotoEntity) => Temporal.PlainDateTime =
        p => p.photo == null ? Clock.now.add({ days: 7 }) : Clock.now.add({ months: 1 });

    export function start(sb: SchemaBuilder, algorithm: IFileTypeAlgorithm): void {
        if (sb.alreadyDefined(start))
            return;

        isStarted = true;

        sb.include(CachedProfilePhotoEntity)
            .withSave(CachedProfilePhotoOperation.Save)
            .withDelete(CachedProfilePhotoOperation.Delete)
            .withQuery();

        FileTypeLogic.register(AuthADFileType.CachedProfilePhoto, algorithm);
    }

    /**
     * Signum's `GetOrCreateCachedPicture(oid, size)` — the cached row for this user at this size,
     * refreshing it from Graph when it has gone stale.
     *
     * The double-check inside the transaction is Signum's: two concurrent requests for the same avatar
     * would otherwise both fetch and both insert, and the unique index on (user, size) would reject one.
     */
    export async function getOrCreateCachedPicture(oid: string, requestedSize: number): Promise<CachedProfilePhotoEntity> {
        return await AuthLogic.withDisabled(async () => {
            const size = toAzureSize(requestedSize);

            const existing = await findRow(oid, size);
            if (existing != null && !isStale(existing))
                return existing;

            const bytes = await AzureADLogic.getUserPhoto(oid, size).catch(() => null);

            return await Transaction.create(async () => {
                const row = await findRow(oid, size);
                if (row != null && !isStale(row))
                    return row;

                if (row != null) {
                    const sameBytes = bytes == null
                        ? row.photo == null
                        : row.photo != null && await sameContent(row.photo, bytes);

                    if (!sameBytes)
                        row.photo = bytes == null ? null : newPhoto(oid, size, bytes);

                    row.invalidationDate = calculateInvalidationDate(row);
                    await row.save();
                    return row;
                }

                const user = await table(UserEntity).filter(u => u.externalId == oid).singleOrNull() as UserEntity | null;
                if (user == null)
                    throw new Error(`No user with ExternalId '${oid}'`);

                const created = CachedProfilePhotoEntity.create({
                    user: user.toLite(),
                    size: toInt(size),
                    photo: bytes == null ? null : newPhoto(oid, size, bytes),
                });
                created.invalidationDate = calculateInvalidationDate(created);
                await created.save();
                return created;
            });
        });
    }

    /** Signum's `HasCachedPicture(oid, size)`. */
    export async function hasCachedPicture(oid: string, requestedSize: number): Promise<boolean> {
        const size = toAzureSize(requestedSize);
        return (await findRow(oid, size)) != null;
    }

    function findRow(oid: string, size: number): Promise<CachedProfilePhotoEntity | null> {
        // `toInt` rather than a cast: the quote-transformer cannot quote a cast, and `size` is the branded
        // `int` the column carries.
        const px = toInt(size);
        return table(CachedProfilePhotoEntity)
            .filter(a => a.user.entity.externalId == oid && a.size == px)
            .singleOrNull() as Promise<CachedProfilePhotoEntity | null>;
    }

    function isStale(row: CachedProfilePhotoEntity): boolean {
        return Temporal.PlainDateTime.compare(row.invalidationDate, Clock.now) < 0;
    }

    function newPhoto(oid: string, size: number, bytes: Buffer): FilePathEmbedded {
        const photo = FilePathEmbedded.create({
            fileType: AuthADFileType.CachedProfilePhoto,
            fileName: `${oid}x${size}.jpg`,
            binaryFile: bytes,
        });
        photo.prepareForSave();
        return photo;
    }

    async function sameContent(photo: FilePathEmbedded, bytes: Buffer): Promise<boolean> {
        const stored = await FilePathEmbeddedLogic.readAllBytes(photo);
        return Buffer.from(stored).equals(bytes);
    }
}
