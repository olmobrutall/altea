import { reflect, init } from "@altea/altea/data/reflection";
import { EmbeddedEntity, ModelEntity, Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { type uuid } from "@altea/altea/data/basics";
import { column } from "@altea/altea/data/decorators";
import { msg } from "@altea/altea/data/utils/localization";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import type { TypeEntity } from "@altea/altea/data/typeEntity";

// LEGACY (kept only for altea-chart's filter-row enums, pending their conversion). The user-assets /
// user-queries DynamicQuery fields now use REAL altea enum tables — see dynamicQueries.ts (central
// registerEnum) and the field declarations (`orderType: OrderTypeEnum`, etc.), which give an int-FK,
// translatable column instead of this varchar-member-name workaround.
//
// Why this ever existed: a field is only recognised as an altea enum when its TS TYPE is the runtime enum
// OBJECT. The DynamicQuery vocabulary is `enum XEnum {}` + `type X = keyof typeof XEnum`; typing a field
// with the string-union alias `X` (no runtime object of that name) made the transformer fall back to a
// plain column — so `@enumColumn()` pinned it to a varchar member-name string. Prefer the enum OBJECT type.
export function enumColumn(): (target: object, propertyKey: string | symbol) => void {
    return column({ pgDbType: "varchar", sqlDbType: "nvarchar", size: 100 });
}

// Port of Signum.UserAssets' UserAssets.cs + Signum.UserAssets.ts — see port/UserAssets.md.
// The shared user-asset contracts: a user-authored, XML-portable entity identified by a stable uuid so it
// can be exported from one database and imported into another.

/** Generate a random RFC-4122 uuid on either tier (browser or node both expose globalThis.crypto). */
export function newGuid(): uuid {
    const c = (globalThis as any).crypto;
    if (c?.randomUUID)
        return c.randomUUID() as uuid;
    // Fallback (very old runtimes): RFC-4122 v4 from Math.random.
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, ch => {
        const r = (Math.random() * 16) | 0;
        const v = ch === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    }) as uuid;
}

/** Any XML-portable user asset. The marker carries NOTHING: the asset is `@primaryKey("uuid")`, so its
 *  `id` IS its portable identity, and the XML (de)serializers are registered server-side. */
export interface IUserAssetEntity extends Entity {
}

/** A user asset that can be scoped to — and offered as a quick-link of — one entity type. */
export interface IHasEntityType extends Entity {
    entityType: Lite<TypeEntity> | null;
}

// Reuses altea-auth's ONE PermissionSymbol table.
export namespace UserAssetPermission {
    export const UserAssetsToXML: PermissionSymbol = init();
}

export const UserAssetMessage = {
    ExportToXml: msg("Export to XML"),
    ImportUserAssets: msg("Import User Assets"),
    ImportPreview: msg("Import Preview"),
    SelectTheXmlFileWithTheUserAssetsThatYouWantToImport: msg("Select the XML file with the user assets that you want to import."),
    SelectTheEntitiesToOverride: msg("Select the entities to override"),
    SucessfullyImported: msg("Sucessfully imported"),
    LooksLikeSomeEntitiesIn0DoNotExistsOrHaveADifferentMeaningInThisDatabase: msg("Looks like some entities in {0} do not exists or have a different meaning in this database"),
    SameSelectionForAllConflictsOf0: msg("Same selection for all conflicts of {0}"),
    _0IsNotFilterable: msg("{0} is not filterable"),
    TheFilterOperation0isNotCompatibleWith1: msg("The filter operation {0} is not compatible with {1}"),
    UserAssetLines: msg("User Asset Lines"),
    Import: msg("Import"),
    AssumeIs: msg("Assume {0} is"),
    UsedBy: msg("Used by"),
    Advanced: msg("Advanced"),
};

// The value/expression toggle on a filter.
export const UserAssetQueryMessage = {
    SwitchToValue: msg("Switch to value"),
    SwitchToExpression: msg("Switch to expression"),
};

// How an incoming asset compares to what the DB already has.
export enum EntityAction {
    Identical,
    Different,
    New,
}

// One row of the import preview: what the file
// contains vs. what the DB has, and whether the admin chose to override it.
@reflect
export class UserAssetPreviewLineEmbedded extends EmbeddedEntity {
    // The asset's clean type name, as a raw string rather than a Lite<TypeEntity>.
    type: string;
    text: string;
    action: EntityAction = EntityAction.New;
    overrideEntity: boolean = false;
    guid: uuid = newGuid();

    toString(): string {
        return this.text;
    }
}

// The whole preview shown before an import is applied.
@reflect
export class UserAssetPreviewModel extends ModelEntity {
    lines: UserAssetPreviewLineEmbedded[];

    toString(): string {
        return UserAssetMessage.ImportPreview.niceToString();
    }
}
