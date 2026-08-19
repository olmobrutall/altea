import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import {
    entity, primaryKey, implementedByAll, uniqueIndex, backReference, rowOrder,
    stringLengthValidator, fieldValidation, quoted,
} from "@altea/altea/data/decorators";
import { ValidationMessage } from "@altea/altea/data/validators";
import { type int } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import { Symbol } from "@altea/altea/data/symbol";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { OrderTypeEnum } from "@altea/altea/data/dynamicQueries";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { FileEmbedded } from "@altea/altea-files/data/Files";
import { QueryTokenEmbedded, QueryFilterBaseEntity } from "@altea/altea-user-assets/data/Queries";
import type { IUserAssetEntity } from "@altea/altea-user-assets/data/UserAssets";
import { ModelConverterSymbol, TemplateApplicableSymbol, type IContainsQuery } from "@altea/altea-templating/data/Templating";
import type { IAttachmentGeneratorEntity } from "@altea/altea-email/data/EmailTemplate";

// Port of Signum.Word's WordTemplate.cs + SystemWordTemplate.cs + WordAttachmentEntity.cs: the AUTHORED
// side of the module — which document is the template, which query rows / model drive it, and how the
// produced file is named and post-processed.
//
// NAMING DIVERGENCE (the whole reason this package is not called `altea-word`): Signum named the module
// after Word, but the SAME engine templates .docx, .pptx AND .xlsx — the parser dispatches on the OOXML
// namespace of each paragraph, not on the file type. So `Word*` becomes `Office*` throughout the public
// surface: WordTemplateEntity → OfficeTemplateEntity, WordModelEntity → OfficeModelEntity,
// WordTransformerSymbol → OfficeTransformerSymbol, WordConverterSymbol → OfficeConverterSymbol,
// WordAttachmentEntity → OfficeAttachmentEntity, WordTemplateOperation.CreateWordReport →
// OfficeTemplateOperation.CreateOfficeReport. Everything else keeps Signum's names and member order, so
// the two remain diffable; when re-applying a Signum change, read `Word` for `Office`.
//
// Other altea divergences, following the sibling @altea/altea-email port exactly:
//  - `MList<QueryFilterEmbedded> / MList<QueryOrderEmbedded>` become this owner's `@part` ROW entities;
//    the filter row reuses @altea/altea-user-assets' shared QueryFilterBaseEntity, so the same
//    FilterBuilderEmbedded editor drives it.
//  - `Guid Guid [UniqueIndex]` (the portable identity) → a uuid PRIMARY KEY: the `id` IS the portable
//    identity, so IUserAssetEntity is a bare marker.
//  - `TemplateApplicableEval` (a compiled C# script) → `applicable: TemplateApplicableSymbol | null`, a
//    code-registered predicate (see @altea/altea-templating's data/Templating.ts for the rationale).
//  - `CultureInfoEntity Culture` → a plain locale STRING (altea has no CultureInfoEntity).
//  - `Lite<FileEntity> Template` → `template: FileEmbedded`. altea-files has no standalone FileEntity row,
//    only the embedded forms; embedding the bytes also removes Signum's "delete the superseded file on
//    save" dance (`Transaction.PreRealCommit += oldFile.Delete()`), since the bytes live in the row.
//  - `ToXml` / `FromXml` / `ParseData` / `IsApplicable` are SERVER-side in altea (System.Xml and the query
//    token resolver are server-only): they live in OfficeTemplateXml.server.ts / OfficeTemplateLogic.server.ts.

// ---- enums ---------------------------------------------------------------------------------------------

/**
 * Where the "create report" menu offers a template (Signum's WordTemplateVisibleOn).
 *
 * A BIT FLAG set, and deliberately NOT an altea reflected enum: altea's reflected enums travel as their
 * member NAME, which cannot express a combination. Signum marks it `[InTypeScript(true)]` and never stores
 * it on an entity — it is registration-time client configuration — so a plain numeric TS enum is both
 * faithful and the only representation that can be OR-ed.
 */
export enum OfficeTemplateVisibleOn {
    Single = 1,
    Multiple = 2,
    Query = 4,
}

// ---- symbols -------------------------------------------------------------------------------------------

/**
 * A registered mutation applied to the OPENED package after the nodes render but before it is saved
 * (Signum's WordTransformerSymbol → `Action<WordContext, OpenXmlPackage>`). Use it to stamp a watermark,
 * swap an image, drop a section.
 */
@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class OfficeTransformerSymbol extends Symbol {
}

/**
 * A registered conversion applied to the SAVED bytes (Signum's WordConverterSymbol →
 * `Func<WordContext, byte[], byte[]>`). Use it to render the document to PDF through an external tool.
 */
@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class OfficeConverterSymbol extends Symbol {
}

// ---- OfficeModel ---------------------------------------------------------------------------------------

/**
 * The registry row for a code-declared model that supplies a template's data (Signum's WordModelEntity).
 * One row per registered IOfficeModel implementation, keyed by its class name — the exact shape
 * @altea/altea-email's EmailModelEntity uses, and synchronised the same way.
 */
@reflect
@entity("SystemString", "Master")
export class OfficeModelEntity extends Entity {
    @uniqueIndex
    @stringLengthValidator({ max: 200 })
    fullClassName: string;

    @quoted
    toString(): string {
        return this.fullClassName;
    }
}

// ---- OfficeTemplate rows -------------------------------------------------------------------------------

// Signum's `MList<QueryFilterEmbedded> Filters` — the shared filter row with this owner's back reference.
@entity("Part", "Master")
export class OfficeTemplateEntity_Filter extends QueryFilterBaseEntity {
    @backReference officeTemplate: Lite<OfficeTemplateEntity>;
}

// Signum's `MList<QueryOrderEmbedded> Orders`.
@entity("Part", "Master")
export class OfficeTemplateEntity_Order extends Entity {
    @backReference officeTemplate: Lite<OfficeTemplateEntity>;
    @rowOrder order: int;

    token: QueryTokenEmbedded;
    orderType: OrderTypeEnum;
}

// ---- OfficeTemplate ------------------------------------------------------------------------------------

// Signum's WordTemplateEntity.
@reflect
@primaryKey("uuid")
@entity("Main", "Master")
export class OfficeTemplateEntity extends Entity implements IUserAssetEntity, IContainsQuery {
    @uniqueIndex
    @stringLengthValidator({ min: 3, max: 200 })
    name: string;

    query: QueryEntity | null;

    model: OfficeModelEntity | null;

    /** A locale name ("en-US"); altea has no CultureInfoEntity (see the header). */
    @stringLengthValidator({ min: 2, max: 20 })
    culture: string;

    groupResults: boolean;

    filters: OfficeTemplateEntity_Filter[];

    @fieldValidation<OfficeTemplateEntity>(t => t.orders.length > 0 && t.query == null
        ? ValidationMessage._0IsNotSet.niceToString("{0}") : null)
    orders: OfficeTemplateEntity_Order[];

    /** altea's stand-in for Signum's compiled `TemplateApplicableEval` (see the header): a code-registered
     *  predicate, resolved through @altea/altea-templating's TemplatingLogic. */
    applicable: TemplateApplicableSymbol | null;

    /** Signum's DisableAuthorization — render this template with row-level/type auth OFF (a system report
     *  must be able to read rows the triggering user cannot). */
    disableAuthorization: boolean;

    /** The template document itself: a .docx / .pptx / .xlsx (Signum's `Lite<FileEntity> Template`). */
    @fieldValidation<OfficeTemplateEntity>(t => officeTemplateValidations.template?.(t) ?? null)
    template: FileEmbedded;

    /** The name given to the RENDERED file. Itself a text template ("Order @[Entity.Id].docx"). */
    @stringLengthValidator({ min: 3, max: 250 })
    @fieldValidation<OfficeTemplateEntity>(t => hasInvalidFileNameChars(t.fileName)
        ? OfficeTemplateMessage.TheFileNameContainsInvalidCharacters.niceToString()
        : officeTemplateValidations.fileName?.(t) ?? null)
    fileName: string;

    officeTransformer: OfficeTransformerSymbol | null;

    officeConverter: OfficeConverterSymbol | null;

    @quoted
    toString(): string {
        return this.name;
    }
}

/**
 * Signum's WordAttachmentEntity — attaches a rendered Office report to an @altea/altea-email message.
 *
 * Shaped exactly like altea-email's FileTokenAttachmentEntity: a plain `Part` implementing the marker
 * interface, with NO back reference — it is reached through `EmailTemplateEntity_Attachment.attachment`,
 * a polymorphic `@valueField`. @altea/altea-email cannot list this type in that field's `@implementedBy`
 * (it would depend on this package, and this package already depends on it), so OfficeAttachmentLogic
 * WIDENS the field with `overrideImplementedBy` at start-up instead — the extension point altea-email's
 * own comment on IAttachmentGeneratorEntity points at.
 */
@reflect
@entity("Part", "Master")
export class OfficeAttachmentEntity extends Entity implements IAttachmentGeneratorEntity {
    /** Overrides the template's own fileName when set. A text template, like OfficeTemplateEntity.fileName. */
    @stringLengthValidator({ min: 3, max: 100 })
    @fieldValidation<OfficeAttachmentEntity>(a => hasInvalidFileNameChars(a.fileName)
        ? OfficeTemplateMessage.TheFileNameContainsInvalidCharacters.niceToString() : null)
    fileName: string | null;

    officeTemplate: Lite<OfficeTemplateEntity>;

    /** Render the report for a DIFFERENT entity than the message's own (Signum's `[ImplementedByAll]`). */
    @implementedByAll
    overrideModel: Lite<Entity> | null;

    /** How to get from the message's entity to `overrideModel`'s type — @altea/altea-templating's registry. */
    modelConverter: ModelConverterSymbol | null;

    @quoted
    toString(): string {
        return this.officeTemplate.toString();
    }
}

/**
 * The SERVER-side halves of Signum's two StaticPropertyValidations on this entity (`ValidateTemplate` /
 * `ValidateFileName`), installed by OfficeTemplateLogic.start. Both need server-only machinery — opening
 * the OOXML package, resolving query tokens — that cannot live in the isomorphic data layer, and the
 * template one is ASYNC, which the core validator contract now allows.
 *
 * Unset on the client, so the live editor validates everything else and learns about these on save.
 */
export const officeTemplateValidations: {
    template?: (t: OfficeTemplateEntity) => Promise<string | null>;
    fileName?: (t: OfficeTemplateEntity) => string | null;
} = {};

const invalidFileNameChars = "\\/:*?\"<>|";
function hasInvalidFileNameChars(fileName: string | null): boolean {
    return fileName != null && [...invalidFileNameChars].some(c => fileName.includes(c));
}

// ---- operations / permissions / messages ---------------------------------------------------------------

export namespace OfficeTemplateOperation {
    export const Save: ExecuteSymbol<OfficeTemplateEntity> = init();
    export const Delete: DeleteSymbol<OfficeTemplateEntity> = init();
    /** Renders the template for the entity it is executed on and returns the produced file. */
    export const CreateOfficeReport: ExecuteSymbol<OfficeTemplateEntity> = init();
    export const CreateOfficeTemplateFromOfficeModel: ConstructSymbol<OfficeTemplateEntity, From<OfficeModelEntity>> = init();
}

export namespace OfficeTemplatePermission {
    export const GenerateReport: PermissionSymbol = init();
}

export const OfficeTemplateMessage = {
    ModelShouldBeSetToUseModel0: msg("Model should be set to use model {0}"),
    Type0DoesNotHaveAPropertyWithName1: msg("Type {0} does not have a property with name {1}"),
    ChooseAReportTemplate: msg("Choose a report template"),
    _01RequiresExtraParameters: msg("{0} {1} requires extra parameters"),
    SelectTheSourceOfDataForYourTableOrChart: msg("Select the source of data for your table or chart"),
    WriteThisKeyAsTileInTheAlternativeTextOfYourTableOrChart: msg("Write this key as Title in the 'Alternative text' of your table or chart"),
    NoDefaultTemplateDefined: msg("No default template defined"),
    OfficeReport: msg("Office report"),
    TheFileNameContainsInvalidCharacters: msg("The file name contains invalid characters"),
};
