import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import {
    entity, uniqueIndex, implementedByAll, stringLengthValidator, index,
} from "@altea/altea/data/decorators";
import { msg } from "@altea/altea/data/utils/localization";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { CultureInfoEntity } from "@altea/altea/data/cultureInfoEntity";
import { TypeEntity } from "@altea/altea/data/typeEntity";
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
 * The route is stored as (`rootType`, `propertyRoute` = its `propertyString()`), the same shape
 * altea-auth's RulePropertyEntity uses — altea does not persist a PropertyRoute table.
 */
@reflect
@uniqueIndex((e: TranslatedInstanceEntity) => [e.culture, e.rootType, e.propertyRoute, e.instance])
@entity("System", "Master")
export class TranslatedInstanceEntity extends Entity {

    culture: CultureInfoEntity;

    /** The row this text belongs to. @implementedByAll — anything can carry a translatable field. */
    @implementedByAll
    instance: Lite<Entity>;

    /** The route's root type, so "every translation of X" is one indexed lookup. */
    @index
    rootType: Lite<TypeEntity>;

    /** The route's `propertyString()` relative to {@link rootType} (e.g. `"name"`, `"address.city"`). */
    @stringLengthValidator({ max: 400 })
    propertyRoute: string;

    @stringLengthValidator({ multiLine: true })
    translatedText: string;

    /**
     * The ORIGINAL text this translation was made from. A translation whose original no longer matches the
     * row's current value is stale — which is exactly what the Sync page lists.
     */
    @stringLengthValidator({ multiLine: true })
    originalText: string;

    toString(): string {
        return `${this.culture?.toString() ?? ""} ${this.instance?.toString() ?? ""} ${this.propertyRoute ?? ""}`;
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
