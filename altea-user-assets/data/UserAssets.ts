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

// Port of Signum's Signum.UserAssets/UserAssets.cs (the shared user-asset contracts) + the client
// Signum.UserAssets.ts message/permission containers. A "user asset" is a user-authored, XML-portable
// entity (a UserQuery, a UserChart, a Dashboard, …) identified by a stable Guid so it can be exported
// from one database and imported into another.
//
// altea divergences, documented inline:
//  - Signum implements `XElement ToXml(ctx)` / `void FromXml(element, ctx)` DIRECTLY on each entity. altea
//    keeps entities isomorphic (no System.Xml on the client), so the XML (de)serialization lives in a
//    SERVER-side per-type registry (UserAssetsExporterImporter.server.ts) instead of on the entity. The
//    isomorphic marker `IUserAssetEntity` therefore only carries `guid`.
//  - `Guid Guid = Guid.NewGuid()` → a `uuid` field defaulted with `newGuid()` (globalThis.crypto), so a
//    freshly-constructed asset already has its portable identity on both tiers (as Signum's ctor did).

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

/** Signum's IUserAssetEntity marker (Signum.UserAssets/UserAssets.cs). Any XML-portable user asset.
 *  altea divergence: Signum's `Guid Guid` identity field is replaced by a uuid PRIMARY KEY on each asset
 *  (`@primaryKey("uuid")`), so the marker carries no `guid` — the asset's `id` IS its portable identity.
 *  The ToXml/FromXml members are server-only in altea (see file header). */
export interface IUserAssetEntity extends Entity {
}

/** Signum's IHasEntityType (Signum.UserAssets/UserAssets.cs): a user asset that can be scoped to (and
 *  offered as a quick-link of) one entity type. */
export interface IHasEntityType extends Entity {
    entityType: Lite<TypeEntity> | null;
}

// Signum's `[AutoInit] static class UserAssetPermission`. Reuses altea-auth's ONE PermissionSymbol table.
export namespace UserAssetPermission {
    export const UserAssetsToXML: PermissionSymbol = init();
}

// Signum's UserAssetMessage (Signum.UserAssets.ts / resx). altea message container: `{ Member: msg("…") }`.
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

// Signum's UserAssetQueryMessage (Signum.UserAssets.Queries.ts) — the value/expression toggle on a filter.
export const UserAssetQueryMessage = {
    SwitchToValue: msg("Switch to value"),
    SwitchToExpression: msg("Switch to expression"),
};

// Signum's EntityAction (UserAssets.cs) — how an incoming asset compares to what the DB already has.
export enum EntityAction {
    Identical,
    Different,
    New,
}

// Signum's UserAssetPreviewLineEmbedded (UserAssets.cs) — one row of the import preview: what the file
// contains vs. what the DB has, and whether the admin chose to override it.
@reflect
export class UserAssetPreviewLineEmbedded extends EmbeddedEntity {
    // The asset's clean type name (Signum's Lite<TypeEntity> Type — here the raw clean name string).
    type: string = "";
    text: string = "";
    action: EntityAction = EntityAction.New;
    overrideEntity: boolean = false;
    guid: uuid = newGuid();

    toString(): string {
        return this.text;
    }
}

// Signum's UserAssetPreviewModel (UserAssets.cs) — the whole preview shown before an import is applied.
@reflect
export class UserAssetPreviewModel extends ModelEntity {
    lines: UserAssetPreviewLineEmbedded[];

    toString(): string {
        return UserAssetMessage.ImportPreview.niceToString();
    }
}
