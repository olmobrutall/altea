import "@altea/altea/server";
import { table } from "@altea/altea/server/table";
import { Saver } from "@altea/altea/server/saver";
import * as Database from "@altea/altea/server/Database";
import { Entity } from "@altea/altea/data/entity";
import { FilePathEmbedded } from "@altea/altea-files/data/Files";
import { HelpImageEntity, HelpImageFileType, type IHelpEntity } from "../data/Help";

// Port of Signum.Help's InlineImagesLogic.cs — the bridge between "an image pasted into the editor" and
// "a file in a store".
//
// The editor emits `<img data-binary-file="<base64>" data-file-name="…">`; on SAVE this walks every HTML
// field of the entity (`foreachHtmlField`), turns each such tag into a real HelpImageEntity + file, and
// rewrites the tag to `<img data-help-image-id="<id>">`. Images whose id no longer appears anywhere are
// deleted. So a description is portable: the HTML carries ids, never bytes.
//
// altea divergences:
//  - **the entity is saved BEFORE its images when it is new**, because `HelpImageEntity.target` is a real
//    FK and a lite of an unsaved row has no id. Signum solves the same problem with a `data-hash` round
//    trip (write the hash, save, then swap hash → id); that is kept verbatim — it also covers the case of
//    two pasted images with identical bytes.
//  - `OperationLogic.AllowSave<HelpImageEntity>()` has NO counterpart and needs none: altea has no
//    "this type requires a Save operation" gate, so an image is simply saved.
//  - `PrimaryKey.Parse(imageId, typeof(HelpImageEntity))` is just the string — the image's PK is a uuid.
export namespace InlineImagesLogic {

    /** Signum's `ImgRegex` — every attribute of an `<img …>` tag, captured as repeated key/value groups. */
    const IMG_REGEX = /<img((?:\s+[\w-]+\s*=\s*"[^"]*")+)\s*\/?>/g;
    const ATTR_REGEX = /([\w-]+)\s*=\s*"([^"]*)"/g;

    /**
     * Signum's `SynchronizeInlineImages`. Returns whether the entity's HTML changed (the caller is the
     * Save operation, so a change is persisted with the entity itself).
     */
    export async function synchronizeInlineImages(entity: IHelpEntity): Promise<boolean> {

        // Every image currently attached; whatever is still here at the end is orphaned.
        const toDelete = new Map<string, HelpImageEntity>();
        if (!entity.isNew)
            for (const img of await imagesOf(entity))
                toDelete.set(String(img.id), img);

        const newImages: HelpImageEntity[] = [];

        // PASS 1 — replace every base64 tag. When the owner already has an id the image can be saved
        // right away and the tag gets its id; when it does not, the tag gets the file HASH and pass 2
        // swaps it for the id once the owner (and then the images) are saved.
        const changed = entity.foreachHtmlField(text => replaceImgTags(text, atts => {
            const next = { ...atts };

            const imageId = atts["data-help-image-id"];
            if (imageId != undefined)
                toDelete.delete(imageId);

            const base64 = atts["data-binary-file"];
            if (base64 == undefined)
                return next;

            delete next["data-binary-file"];

            const file = FilePathEmbedded.create({
                fileType: HelpImageFileType.Image,
                fileName: atts["data-file-name"] ?? "image.png",
                binaryFile: base64ToBytes(base64),
            });
            file.prepareForSave();

            const image = HelpImageEntity.create({
                file,
                target: entity.toLite(),
            });

            newImages.push(image);
            // The hash is a stable handle for THIS tag until the image has an id (Signum's data-hash).
            next["data-hash"] = hashKeyOf(file);

            return next;
        }));

        for (const orphan of toDelete.values())
            await Database.deleteList([orphan]);

        if (!changed)
            return false;

        if (newImages.length > 0) {
            // The owner first, so every image's `target` lite has an id to point at.
            await Saver.save([entity as unknown as Entity]);
            await Saver.save(newImages);

            const idByHash = new Map(newImages.map(i => [hashKeyOf(i.file), String(i.id)]));

            // PASS 2 — swap each data-hash for the image's real id.
            entity.foreachHtmlField(text => replaceImgTags(text, atts => {
                const next = { ...atts };
                const hash = atts["data-hash"];
                if (hash != undefined) {
                    delete next["data-hash"];
                    const id = idByHash.get(hash);
                    if (id != undefined)
                        next["data-help-image-id"] = id;
                }
                return next;
            }));
        }

        return true;
    }

    /** Signum's `IHelpEntity.Images()` expression. */
    export async function imagesOf(entity: IHelpEntity): Promise<HelpImageEntity[]> {
        const lite = entity.toLite();
        return await table(HelpImageEntity).filter(i => i.target.is(lite)).toArray();
    }

    /**
     * The per-tag handle used between the two passes. `FilePathEmbedded.hash` is filled SERVER-side (the
     * save hook computes it), so at this point it is still null — the bytes' own length + name is enough to
     * pair a tag with the image built from it within one call, which is all the handle has to do.
     */
    function hashKeyOf(file: FilePathEmbedded): string {
        return `${file.fileName}|${file.binaryFile?.length ?? 0}|${file.hash ?? ""}`;
    }

    function replaceImgTags(text: string, transform: (atts: Record<string, string>) => Record<string, string>): string {
        return text.replace(IMG_REGEX, (_match, attrsPart: string) => {
            const atts = parseAttributes(attrsPart);
            const next = transform(atts);
            const rendered = Object.entries(next).map(([k, v]) => `${k}="${v}"`).join(" ");
            return `<img ${rendered}/>`;
        });
    }

    /**
     * Signum's `GetTagAttributes` — it zips the regex's repeated `key` / `value` CAPTURES, which .NET
     * exposes and JavaScript does not (a repeated group keeps only its LAST match). So the attribute list
     * is captured as one blob above and re-scanned here, the same adaptation altea-omnibox made for its
     * syntax grammar.
     */
    function parseAttributes(attrsPart: string): Record<string, string> {
        const result: Record<string, string> = {};
        for (const m of attrsPart.matchAll(ATTR_REGEX))
            result[m[1]] = m[2];
        return result;
    }

    function base64ToBytes(base64: string): Uint8Array {
        // The editor may hand over a full data URL (`data:image/png;base64,…`) or the bare payload.
        const payload = base64.includes(",") ? base64.substring(base64.indexOf(",") + 1) : base64;
        return new Uint8Array(Buffer.from(payload, "base64"));
    }
}
