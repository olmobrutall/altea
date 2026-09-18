import { reflect, init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, uniqueIndex, implementedByAll, index, format, niceName } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import { msg } from "@altea/altea/data/utils/localization";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { CultureInfoEntity } from "@altea/altea/data/cultureInfoEntity";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { PropertyRouteEntity } from "@altea/altea/data/propertyRouteEntity";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";

// Port of Signum.Translation's TranslationReplacement.cs + Instances/TranslatedInstance.cs +
// TranslatorMessage.cs — the two stored types of the module and its vocabulary.
//
// The module has TWO halves, and it helps to keep them apart while reading:
//   • CODE translations — the per-package `translations/*.xml` files that carry every type's and member's
//     nice name. Nothing is stored in the database; the pages edit the FILES.
//   • INSTANCE translations — {@link TranslatedInstanceEntity}: the translated value of one @translatable
//     field of one row. That IS a table.
// {@link TranslationReplacementEntity} serves both: a house-style correction applied on top of whatever
// an automatic translator returns.

export namespace TranslationPermission {
    /** Gates the code half: editing the per-package translation XML files. */
    export const TranslateCode: PermissionSymbol = init();
    /** Gates the instance half: editing per-instance translated fields. */
    export const TranslateInstances: PermissionSymbol = init();
}

// ---- Instance translations -----------------------------------------------------------------------------

/**
 * Signum's `TranslatedInstanceEntity` — one field of one row, in one culture.
 *
 * altea divergence: **there is no `RowId`.** Signum keys a translation by (root instance, a route that may
 * run THROUGH an MList, rowId), because an MList row is not an entity. altea has no MList — a collection
 * is `@part` child ENTITIES, each with its own id and its own PropertyRoute root — so the owning row IS
 * the instance and the route is always rooted at it. The `RowId` column, its PropertyValidation and the
 * `"route;rowId"` composite key all collapse (see core's PropertyRouteTranslationLogic for the full note).
 *
 * The route is a `PropertyRouteEntity` reference, as in Signum. (It used to be stored as
 * (`rootType`, `propertyRoute` = its `propertyString()`), because altea had no such table; it does now —
 * see altea/data/propertyRouteEntity.ts — and the row carries its own root type, so the separate
 * `rootType` column is gone with it: "every translation of X" joins through the route instead.)
 */
@reflect
@uniqueIndex((e: TranslatedInstanceEntity) => [e.culture, e.propertyRoute, e.instance, e.rowId])
@entity("System", "Master")
export class TranslatedInstanceEntity extends Entity {

    culture: CultureInfoEntity;

    /** The row this text belongs to. @implementedByAll — anything can carry a translatable field. */
    @implementedByAll
    instance: Lite<Entity>;

    propertyRoute: PropertyRouteEntity;

    /**
     * Signum's `string? RowId` — WHICH ROW of a collection this translation is for, when the property
     * route runs through one ("Dashboard.Parts/Title" needs a row; "Dashboard.DisplayName" must not have
     * one, which is what Signum's PropertyValidation on this field enforces). A string because the row's
     * primary key can be of any of the configured key types.
     */
    rowId: string | null;

    @stringLengthValidator({ multiLine: true })
    translatedText: string;

    /**
     * The ORIGINAL text this translation was made from. A translation whose original no longer matches the
     * row's current value is stale — which is exactly what the Sync page lists.
     */
    @stringLengthValidator({ multiLine: true })
    originalText: string;

    toString(): string {
        return `${this.culture?.toString() ?? ""} ${this.instance?.toString() ?? ""} ${this.propertyRoute?.toString() ?? ""}`;
    }
}

export namespace TranslatedInstanceOperation {
    export const Delete: DeleteSymbol<TranslatedInstanceEntity> = init();
}

/** Signum's TranslatedSummaryState — how far along one (type, culture) pair is. */
export enum TranslatedSummaryState {
    Completed,
    Pending,
    None,
}

/**
 * Signum's MatchTranslatedInstances — how an imported .xlsx is matched back to rows.
 *  • ByInstanceID   — export and import happened in the SAME database (stable ids);
 *  • ByOriginalText — different databases (a generated environment), so the ORIGINAL text is the key.
 */
export enum MatchTranslatedInstances {
    ByInstanceID,
    ByOriginalText,
}

// ---- Translation replacements --------------------------------------------------------------------------

/**
 * Signum's `TranslationReplacementEntity`: "whenever an automatic translator produces X in this culture,
 * write Y instead" — the house-style layer over Azure / DeepL output. Fed by the editor's feedback (you
 * correct a suggestion, the correction is remembered).
 */
@reflect
@uniqueIndex((e: TranslationReplacementEntity) => [e.cultureInfo, e.wrongTranslation])
@entity("Main", "Master")
export class TranslationReplacementEntity extends Entity {

    cultureInfo: CultureInfoEntity;

    @stringLengthValidator({ min: 3, max: 200 })
    wrongTranslation: string;

    @stringLengthValidator({ min: 3, max: 200 })
    rightTranslation: string;
}

export namespace TranslationReplacementOperation {
    export const Save: ExecuteSymbol<TranslationReplacementEntity> = init();
    export const Delete: DeleteSymbol<TranslationReplacementEntity> = init();
}

// ---- Messages ------------------------------------------------------------------------------------------

export const TranslationMessage = {
    RepeatedCultures0: msg("Repeated cultures {0}"),
    CodeTranslations: msg("Code translations"),
    InstanceTranslations: msg("Instance translations"),
    Synchronize0In1: msg("Synchronize {0} in {1}"),
    View0In1: msg("View {0} in {1}"),
    AllLanguages: msg("all languages"),
    _0AlreadySynchronized: msg("{0} already synchronized"),
    NothingToTranslate: msg("Nothing to translate"),
    All: msg("All"),
    NothingToTranslateIn0: msg("Nothing to translate in {0}"),
    Sync: msg("sync"),
    View: msg("view"),
    None: msg("none"),
    Edit: msg("edit"),
    AutoSync: msg("auto-sync"),
    Member: msg("Member"),
    Type: msg("Type"),
    Instance: msg("Instance"),
    Property: msg("Property"),
    Save: msg("Save"),
    Search: msg("Search"),
    PressSearchForResults: msg("Press search for results..."),
    NoResultsFound: msg("No results found"),
    // Signum groups the code-translation sync by C# NAMESPACE. altea has no namespaces — a package's
    // types are grouped by the DIRECTORY they are declared in (see server/TranslationFiles).
    Folder: msg("Folder"),
    NewTypes: msg("New types"),
    NewTranslations: msg("New translations"),
    BackToTranslationStatus: msg("Back to translation status"),
    BackToSyncPackage0: msg("Back to sync package {0}"),
    ThisFieldIsTranslatable: msg("This field is translatable"),
    _0OutdatedTranslationsFor1HaveBeenDeleted: msg("{0} outdated translations for {1} have been deleted"),
    DownloadView: msg("Download view"),
    DownloadSync: msg("Download sync"),
    Download: msg("Download"),
    AreYouSureToContinueAutoTranslation0For1WithoutRevision: msg("Are you sure to continue auto translation {0} for {1} without revision?"),
    AreYouSureToContinueAutoTranslationAllTypesFor0WithoutRevision: msg("Are you sure to continue auto translation all types for {0} without revision?"),
    AreYouSureToContinueAutoTranslationAllPackagesFor0WithoutRevision: msg("Are you sure to continue auto translation all packages for {0} without revision?"),
    TranslationStatus: msg("Translation status"),
    Singular: msg("Singular"),
    Plural: msg("Plural"),
    PluralDescription: msg("Plural description"),
    Description: msg("Description"),
    Gender: msg("Gender"),
    Culture: msg("Culture"),
    TranslationsOverview: msg("Translations overview"),
    InstanceRouteConflictsOverview: msg("Instance route conflicts overview"),
    TranslationFor0_: msg("Translation for {0}"),
    OnlyNeutralCultures: msg("Only neutral cultures"),
    OnlyRecommendedInstances: msg("Only recommended instances"),
    From0using1_: msg("from {0} using {1}"),
    SelectAxlsxFileWithTheTranslations: msg("Select a .xlsx file with the translations"),
    NoRoutesMarkedForTranslationConsiderUsing: msg("No routes marked for translation. Consider using "),
    Package: msg("Package"),
};

export const TranslationJavascriptMessage = {
    WrongTranslationToSubstitute: msg("Wrong translation to substitute"),
    RightTranslation: msg("Right translation"),
    RememberChange: msg("Remember change"),
};

/**
 * The credentials the machine translators need — Signum's `TranslationConfigurationEmbedded`.
 *
 * Signum declares this in the APPLICATION (Southwind/Globals), because its translators are constructed in
 * the app's Starter and nothing else needs the shape. altea declares it in the MODULE instead, which is
 * what every other altea configuration section does — `ChatbotConfigurationEmbedded` is altea-agent's,
 * `SMSConfigurationEmbedded` is altea-sms's — so an application gets the fields, the labels and their
 * translations by holding one field rather than by re-declaring three.
 *
 * It is still the APP that wires them: `TranslationLogic.start` takes translators, and the two that need a
 * key take a LAMBDA over this row, so rotating one is a save rather than a restart.
 *
 * Empty is the normal state. Both translators answer `null` for a missing key, which the chain reads as
 * "nothing to suggest" — the sync pages work with no credentials at all.
 */
@reflect
export class TranslationConfigurationEmbedded extends EmbeddedEntity {

    // All three carry Signum's `[Description]`, for Signum's reason: de-camelCasing an identifier with an
    // acronym in it does not produce the product's name. `deepLAPIKey` humanises to "Deep LAPI key".
    @niceName("Azure Cognitive Service API Key")
    @stringLengthValidator({ max: 300 }) @format("Password")
    azureCognitiveServicesAPIKey: string | null = null;

    /** The Azure resource's region ("westeurope"). Not a secret, and optional: a global resource has none. */
    @niceName("Azure Cognitive Service Region")
    @stringLengthValidator({ max: 300 })
    azureCognitiveServicesRegion: string | null = null;

    @niceName("DeepL API Key")
    @stringLengthValidator({ max: 300 }) @format("Password")
    deepLAPIKey: string | null = null;
}

// The database schema this package's tables live in — altea's counterpart of Signum's
// `[assembly: AssemblySchemaName("translation")]`. FOLDER-scoped, so it covers every type declared
// beside it; the name is logical and gets dialect-mapped (schemaForType), so Postgres sees it snaked.
setDefaultDatabaseSchema("translation");
