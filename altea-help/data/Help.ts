import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity, ModelEntity, type Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import {
    entity, implementedBy, implementedByAll, backReference, rowOrder,
    stringLengthValidator, column, primaryKey,
} from "@altea/altea/data/decorators";
import { noRepeatValidator } from "@altea/altea/data/validators";
import { msg } from "@altea/altea/data/utils/localization";
import { Clock } from "@altea/altea/data/utils/clock";
import { Temporal, type int } from "@altea/altea/data/basics";
import { OperationSymbol } from "@altea/altea/data/operations";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { CultureInfoEntity } from "@altea/altea/data/cultureInfoEntity";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { FilePathEmbedded, FileTypeSymbol } from "@altea/altea-files/data/Files";
import type { OmniboxResult, OmniboxMatch } from "@altea/altea-omnibox/data/OmniboxResults";

// Port of Signum.Help's entity model (TypeHelp.cs / NamespaceHelp.cs / AppendixHelp.cs / QueryHelp.cs /
// HelpImage.cs / HelpCommon.cs) plus the wire DTOs its pages read.
//
// The module documents an APPLICATION: for every type, every property, every operation and every query, a
// prose description that is AUTO-GENERATED from reflection (`info`, computed per request — see
// HelpGenerator) and, optionally, a human-written one stored here (`description`). A help page shows the
// generated line greyed out and lets an authorized user write over it in place.
//
// ---- altea divergences in the model ----------------------------------------------------------------
//
//  - **`PropertyRouteEntity` does not exist in altea**, so a property's help is keyed by the route STRING
//    (`propertyRoute`, a `propertyString()` like `"shipAddress.city"`) — the same key altea-auth's
//    `RulePropertyEntity.path` uses, and the same one the client's PropertyRoute parses back. Signum's
//    `PreDeleteSqlSync` cascade from PropertyRouteEntity goes with the table; a route that no longer
//    exists is dropped by the SYNCHRONIZER instead (HelpLogic.synchronize), which is where Signum also
//    prunes renamed ones.
//  - **`NamespaceHelpEntity.name` holds a PACKAGE + FOLDER**, not a C# namespace — `"@altea/altea-auth/data"`,
//    `"eastwind/orders"`. That is the same grouping string @altea/altea-map's schema map colours by (read
//    off the transformer's `__fileInfo` through `getLocation`), so the two features agree on what a
//    "module" is. The entity keeps Signum's NAME so the ported pages and the XML round-trip read unchanged.
//  - **MList → `@part` rows**: `PropertyRouteHelpEmbedded` / `OperationHelpEmbedded` /
//    `QueryColumnHelpEmbedded` and the two import-line embeddeds become child ENTITIES with a
//    `@backReference` to their owner. Signum's `WithUniqueIndexMList` becomes an ordinary unique index on
//    the child table.
//  - **`QueryHelpEntity.columns` is keyed by a rootless QUERY TOKEN**, not by a declared column name.
//    Signum reads `IDynamicQueryCore.StaticColumns`; altea has no QueryDescription and no static column
//    list — "the columns of a query" are the root token's sub-tokens (see CLAUDE.md). The field keeps
//    Signum's name `columnName` because the XML round-trip and the sync replacements key off it.
//  - `IHelpEntity` is a TS interface over `Entity` (altea has no `IEntity`); `ForeachHtmlField` is a plain
//    method each implementor declares, exactly as in Signum.
//  - `HelpImageEntity` keeps Signum's `[PrimaryKey(typeof(Guid))]` as `@primaryKey("uuid")`,
//    because the image id is embedded in saved HTML (`data-help-image-id`) and travels between databases
//    through the ZIP export.

// ---- permissions ---------------------------------------------------------------------------------
// Declared, not registered: altea's SymbolLogic picks up every `init()`ed symbol, so Signum's
// `PermissionLogic.RegisterPermissions(...)` has no counterpart.
export namespace HelpPermissions {
    /** Gates every page, every route and the frame widget. */
    export const ViewHelp: PermissionSymbol = init();
    /** Gates the "export as zip" quick link and the import page. */
    export const ExportHelp: PermissionSymbol = init();
}

export namespace HelpImageFileType {
    export const Image: FileTypeSymbol = init();
}

// ---- the marker every help entity implements ------------------------------------------------------

/**
 * Signum's `IHelpEntity`. `foreachHtmlField` visits every HTML-bearing field of the entity, replacing each
 * with what the callback returns, and answers whether anything changed — the hook
 * `InlineImagesLogic.synchronizeInlineImages` uses to pull pasted base64 images out into files.
 */
export interface IHelpEntity extends Entity {
    foreachHtmlField(processHtml: (html: string) => string): boolean;
}

/** Runs `processHtml` over one nullable HTML field held in a box, Signum's inlined per-field block. */
function processField<T extends object, K extends keyof T>(owner: T, key: K, processHtml: (html: string) => string): boolean {
    const current = owner[key] as string | null;
    if (current == null)
        return false;
    const next = processHtml(current);
    if (next === current)
        return false;
    owner[key] = next as T[K];
    return true;
}

// ---- TypeHelp ------------------------------------------------------------------------------------

@reflect
@entity("Main", "Master")
export class TypeHelpEntity extends Entity implements IHelpEntity {

    type: TypeEntity;

    culture: CultureInfoEntity;

    @stringLengthValidator({ multiLine: true })
    description: string | null = null;

    @noRepeatValidator()
    properties: TypeHelpEntity_Property[];

    @noRepeatValidator()
    operations: TypeHelpEntity_Operation[];

    /**
     * Signum's `[Ignore] MList<QueryHelpEntity> Queries`: NOT a column and NOT a `@part` collection — each
     * QueryHelp is its own row, shared by every type the query belongs to. The server fills this list per
     * request (HelpServer's type route) and saves each element separately.
     */
    @column(false)
    queries: QueryHelpEntity[];

    /** Signum's `[Ignore] Info` — the reflection-generated line, recomputed per request. */
    @column(false)
    info: string | null = null;

    /**
     * ALTEA: the type's NAMESPACE (package + declaring folder), filled per request like `info`.
     * Signum's client reads it off `typeHelp.type.namespace` — its TypeEntity carries one, because a C#
     * namespace is a property of the type. altea's namespace is derived from the transformer's
     * `__fileInfo` on the SERVER (HelpLogic.namespaceOf), so the page is told rather than deriving it.
     */
    @column(false)
    namespace: string | null = null;

    toString(): string {
        return this.type?.toString() ?? "";
    }

    /** Signum's computed `IsEmpty`: nothing worth a row. Used by the save route to delete instead. */
    isEmpty(): boolean {
        return !this.description && this.properties.length === 0 && this.operations.length === 0;
    }

    foreachHtmlField(processHtml: (html: string) => string): boolean {
        let changed = processField(this, "description", processHtml);
        for (const prop of this.properties)
            changed = processField(prop, "description", processHtml) || changed;
        for (const oper of this.operations)
            changed = processField(oper, "description", processHtml) || changed;
        return changed;
    }
}

/** Signum's `PropertyRouteHelpEmbedded` — a `@part` row here (see the header on MList). */
@reflect
@entity("Part", "Master")
export class TypeHelpEntity_Property extends Entity {

    @backReference
    typeHelp: TypeHelpEntity;

    @rowOrder order: int;

    /** The route's `propertyString()` — altea has no PropertyRouteEntity (see the header). */
    @stringLengthValidator({ max: 300 })
    propertyRoute: string;

    @column(false)
    info: string | null = null;

    @stringLengthValidator({ multiLine: true })
    description: string | null = null;

    toString(): string {
        return this.propertyRoute ?? "";
    }
}

/** Signum's `OperationHelpEmbedded`. */
@reflect
@entity("Part", "Master")
export class TypeHelpEntity_Operation extends Entity {

    @backReference
    typeHelp: TypeHelpEntity;

    @rowOrder order: int;

    operation: OperationSymbol;

    @column(false)
    info: string | null = null;

    @stringLengthValidator({ multiLine: true })
    description: string | null = null;

    toString(): string {
        return this.operation?.toString() ?? "";
    }
}

export namespace TypeHelpOperation {
    export const Save: ExecuteSymbol<TypeHelpEntity> = init();
    export const Delete: DeleteSymbol<TypeHelpEntity> = init();
}

// ---- NamespaceHelp -------------------------------------------------------------------------------

@reflect
@entity("Main", "Master")
export class NamespaceHelpEntity extends Entity implements IHelpEntity {

    /** The package + declaring folder (see the header) — Signum's C# namespace. */
    @stringLengthValidator({ max: 300 })
    name: string;

    culture: CultureInfoEntity;

    @stringLengthValidator({ max: 200 })
    title: string | null = null;

    @stringLengthValidator({ multiLine: true })
    description: string | null = null;

    toString(): string {
        return this.name ?? "";
    }

    foreachHtmlField(processHtml: (html: string) => string): boolean {
        return processField(this, "description", processHtml);
    }
}

export namespace NamespaceHelpOperation {
    export const Save: ExecuteSymbol<NamespaceHelpEntity> = init();
    export const Delete: DeleteSymbol<NamespaceHelpEntity> = init();
}

// ---- AppendixHelp --------------------------------------------------------------------------------

@reflect
@entity("Main", "Master")
export class AppendixHelpEntity extends Entity implements IHelpEntity {

    @stringLengthValidator({ min: 3, max: 100 })
    uniqueName: string;

    culture: CultureInfoEntity;

    @stringLengthValidator({ max: 200 })
    title: string;

    @stringLengthValidator({ min: 3, multiLine: true })
    description: string | null = null;

    toString(): string {
        return this.title ?? "";
    }

    foreachHtmlField(processHtml: (html: string) => string): boolean {
        return processField(this, "description", processHtml);
    }
}

export namespace AppendixHelpOperation {
    export const Save: ExecuteSymbol<AppendixHelpEntity> = init();
    export const Delete: DeleteSymbol<AppendixHelpEntity> = init();
}

// ---- QueryHelp -----------------------------------------------------------------------------------

@reflect
@entity("SharedPart", "Master")
export class QueryHelpEntity extends Entity implements IHelpEntity {

    query: QueryEntity;

    culture: CultureInfoEntity;

    @column(false)
    info: string | null = null;

    @stringLengthValidator({ multiLine: true })
    description: string | null = null;

    @noRepeatValidator()
    columns: QueryHelpEntity_Column[];

    toString(): string {
        return this.query?.toString() ?? "";
    }

    isEmpty(): boolean {
        return !this.description && this.columns.length === 0;
    }

    foreachHtmlField(processHtml: (html: string) => string): boolean {
        let changed = processField(this, "description", processHtml);
        for (const col of this.columns)
            changed = processField(col, "description", processHtml) || changed;
        return changed;
    }
}

/** Signum's `QueryColumnHelpEmbedded`. `columnName` holds a rootless TOKEN key (see the header). */
@reflect
@entity("Part", "Master")
export class QueryHelpEntity_Column extends Entity {

    @backReference
    queryHelp: QueryHelpEntity;

    @rowOrder order: int;

    @stringLengthValidator({ max: 100 })
    columnName: string;

    @stringLengthValidator({ multiLine: true })
    description: string | null = null;

    @column(false)
    niceName: string | null = null;

    @column(false)
    info: string | null = null;

    toString(): string {
        return this.columnName ?? "";
    }
}

export namespace QueryHelpOperation {
    export const Save: ExecuteSymbol<QueryHelpEntity> = init();
    export const Delete: DeleteSymbol<QueryHelpEntity> = init();
}

// ---- HelpImage -----------------------------------------------------------------------------------

/**
 * An image pasted into a help description. The bytes live in a file store; the HTML keeps only
 * `data-help-image-id`, so the same description renders in any environment the ZIP was imported into.
 */
@reflect
@primaryKey("uuid")
@entity("Part", "Master")
export class HelpImageEntity extends Entity {

    @implementedBy(() => [AppendixHelpEntity, NamespaceHelpEntity, QueryHelpEntity, TypeHelpEntity])
    target: Lite<IHelpEntity>;

    creationDate: Temporal.PlainDateTime = Clock.now;

    file: FilePathEmbedded;

    toString(): string {
        return this.file?.fileName ?? "";
    }
}

// ---- the import preview / report models ----------------------------------------------------------

export enum ImportActionEnum {
    NoChange,
    Create,
    Override,
}
export type ImportAction = keyof typeof ImportActionEnum;

export enum ImportStatusEnum {
    NoChange,
    Applied,
    Failed,
    Skipped,
}
export type ImportStatus = keyof typeof ImportStatusEnum;

/**
 * Signum's `HelpImportPreviewLineEmbedded`. One line per `.help` file found in the uploaded zip: what it
 * is, what importing it would do, and (the user's call) whether to apply it.
 *
 * ALTEA: these are plain EMBEDDEDs on a ModelEntity, NOT `@part` rows — the shape altea-user-assets'
 * `UserAssetPreviewLineEmbedded` already uses for the same job. A `@part` collection's `@backReference`
 * needs a real owner TABLE to point at, and a ModelEntity has none (it is never included), so the
 * serializer's recover step has no lite to build — which is exactly how the first live import failed
 * ("slot.owner.toLite is not a function"). Signum's two line types share an abstract
 * `HelpImportLineBase`; kept as two flat declarations here, in Signum's field order.
 */
@reflect
export class HelpImportPreviewLineEmbedded extends EmbeddedEntity {

    type: TypeEntity;

    key: string;

    culture: CultureInfoEntity;

    text: string | null = null;

    action: ImportAction;

    exitingEntity: Lite<Entity> | null = null;

    apply: boolean | null = null;

    /** Signum's computed `ApplyVisible`: only an actionable line gets a checkbox. */
    applyVisible(): boolean {
        return this.action !== "NoChange";
    }

    toString(): string {
        return `${this.type?.toString() ?? ""} ${this.key} ${this.action}`;
    }
}

@reflect
export class HelpImportPreviewModel extends ModelEntity {
    lines: HelpImportPreviewLineEmbedded[];

    toString(): string {
        return HelpMessage.ImportHelpContentsFromZipFile.niceToString();
    }
}

@reflect
export class HelpImportReportLineEmbedded extends EmbeddedEntity {

    type: TypeEntity;

    key: string;

    culture: CultureInfoEntity;

    text: string | null = null;

    action: ImportAction;

    exitingEntity: Lite<Entity> | null = null;

    status: ImportStatus;

    actionError: string | null = null;

    toString(): string {
        return `${this.type?.toString() ?? ""} ${this.key} ${this.status}`;
    }
}

@reflect
export class HelpImportReportModel extends ModelEntity {
    lines: HelpImportReportLineEmbedded[];

    toString(): string {
        return HelpMessage.ImportReport.niceToString();
    }
}

// ---- messages ------------------------------------------------------------------------------------

export const HelpMessage = {
    _0IsA1_G: msg("{0} is a {1}"),
    AnEmbeddedEntityOfType0: msg("An embedded entity of type {0}"),
    AReference1ToA2_G: msg("A reference ({1}) to a {2}"),
    lite: msg("lite"),
    full: msg("full"),
    _0IsA1AndShows2: msg("{0} is a {1} and shows {2}"),
    _0IsACalculated1: msg("{0} is a calculated {1}"),
    _0IsACollectionOfElements1: msg("{0} is a collection of elements {1}"),
    Amount: msg("amount"),
    Any: msg("any"),
    Appendices: msg("Appendices"),
    Call0Over1OfThe2: msg("Call {0} over {1} of the {2}"),
    Character: msg("character"),
    BooleanValue: msg("boolean value (yes or no)"),
    ConstructsANew0: msg("Constructs a new {0}"),
    Date: msg("date"),
    DateTime: msg("date and time"),
    ExpressedIn: msg("expressed in "),
    From0OfThe1: msg("from {0} of the {1}"),
    FromMany0: msg("from many {0}"),
    Help: msg("Help"),
    HelpNotLoaded: msg("Help not loaded"),
    Integer: msg("integer"),
    Key0NotFound: msg("Key {0} not found"),
    Optional: msg(" (optional)"),
    Property0NotExistsInType1: msg("Property {0} does not exist in type {1}"),
    QueryOf0: msg("Query of {0}"),
    RemovesThe0FromTheDatabase: msg("Removes the {0} from the database"),
    Should: msg(". Should  "),
    String: msg("string"),
    TheDatabaseVersion: msg("the database version"),
    TheProperty0: msg("the property {0}"),
    Value: msg("value"),
    ValueLike0: msg("value like {0}"),
    YourVersion: msg("your version"),
    _0IsThePrimaryKeyOf1OfType2: msg("{0} is the primary key of {1}, of type {2}"),
    In0: msg("(in {0})"),
    Entities: msg("Entities"),
    SearchText: msg("Search text"),
    Previous: msg("Previous"),
    Next: msg("Next"),
    Edit: msg("Edit"),
    Close: msg("Close"),
    ViewMore: msg("View more"),
    JumpToViewMore: msg("Jump to view more"),
    ExportAsZip: msg("Export as zip"),
    Import: msg("Import"),
    ImportCompletedSuccessfully: msg("Import completed successfully"),
    ImportCompletedWithErrors: msg("Import completed with errors"),
    ImportReport: msg("Import report"),
    ImportError: msg("Import error"),
    ImportHelpContentsFromZipFile: msg("Import help contents from zip file"),
    SelectTheZIPFileWithTheHelpContentsThatYouWantToImport: msg("Select the ZIP file with the help contents that you want to import"),
    ChooseZIPFile: msg("Choose ZIP file"),
    SelectedFile: msg("Selected file"),
    HelpZipContents: msg("Help zip contents"),
    NewKey: msg("New key"),
    ActionStatus: msg("Action status"),
    // ALTEA: Signum's Shortcut chip reuses `FrameMessage.CopyToClipboard`, which altea's FrameMessage
    // does not have (only `Copied`); the label belongs to this feature anyway.
    CopyLinkToken: msg("Copy this link token to the clipboard"),
    // Signum's `Buscador` (a Spanish leftover meaning "search page") is not ported — nothing reads it.
    Types: msg("Types"),
};

export const HelpKindMessage = {
    HisMainFunctionIsTo0: msg("His main function is to {0}"),
    RelateOtherEntities: msg("relate other entities"),
    ClassifyOtherEntities: msg("classify other entities"),
    StoreInformationSharedByOtherEntities: msg("store information shared by other entities"),
    StoreInformationOnItsOwn: msg("store information on its own"),
    StorePartOfTheInformationOfAnotherEntity: msg("store part of the information of other entity"),
    StorePartsOfInformationSharedByDifferentEntities: msg("store parts of information shared by different entities"),
    AutomaticallyByTheSystem: msg(" automatically by the system"),
    AndIsMasterDataRarelyChanges: msg(" and is Master Data (rarely changes)"),
    andIsTransactionalDataCreatedRegularly: msg(" and is Transactional Data (created regularly)"),
};

export const HelpSearchMessage = {
    Search: msg("Search"),
    _0ResultsFor1In2: msg("{0} result[s] for {1} (in {2} ms)"),
    Results: msg("Results"),
    NoResults: msg("No results"),
};

// Signum's `HelpSyntaxMessage` documented the WIKI syntax its old editor used. altea's editor is
// altea-html-editor (Lexical, WYSIWYG) — bold / italic / lists / links / images are toolbar buttons, not
// typed markup — so the only piece of that syntax still real is the `[t:Type]` link token the descriptions
// carry, which is inserted by copying a page's shortcut chip. What survives is therefore just the two
// labels the editors use.
export const HelpSyntaxMessage = {
    InsertImage: msg("Insert image"),
    TranslateFrom: msg("Translate from..."),
};

// ---- the search result (Signum's HelpSearch.cs SearchResult) --------------------------------------

export enum TypeSearchResultEnum {
    Appendix,
    Namespace,
    Type,
    Property,
    Query,
    Operation,
}
export type TypeSearchResult = keyof typeof TypeSearchResultEnum;

export enum MatchTypeEnum {
    Total,
    StartsWith,
    Contains,
}
export type MatchType = keyof typeof MatchTypeEnum;

/** Signum's `SearchResult`. `key` / `key2` address the page + anchor the hit links to. */
export interface HelpSearchResult {
    typeSearchResult: TypeSearchResult;
    title: string;
    matchType: MatchType;
    description: string | null;
    key: string;
    key2: string | null;
    isDescription: boolean;
}

export interface HelpSearchResponse {
    query: string;
    elapsedMs: number;
    results: HelpSearchResult[];
}

// ---- the index / namespace wire DTOs (Signum's HelpIndexTS & friends) ----------------------------

export interface HelpIndexTS {
    culture: CultureInfoEntity;
    namespaces: NamespaceItemTS[];
    appendices: AppendiceItemTS[];
}

export interface NamespaceItemTS {
    namespace: string;
    /** The owning PACKAGE — the first grouping level of the index page (Signum's assembly-ish "module"). */
    module?: string;
    title: string;
    hasEntity?: boolean;
    allowedTypes: EntityItem[];
}

export interface EntityItem {
    cleanName: string;
    hasEntity?: boolean;
}

export interface AppendiceItemTS {
    title: string;
    uniqueName: string;
}

export interface NamespaceHelpTS {
    namespace: string;
    title: string;
    description?: string | null;
    entity: NamespaceHelpEntity;
    allowedTypes: EntityItem[];
}

/** The POST body of the two import routes (Signum's `FileUpload` / `FileUploadWithModel`). */
export interface HelpFileUpload {
    fileName: string;
    /** base64, as the browser's FileReader produces it. */
    content: string;
}

// ---- the omnibox suggestion ----------------------------------------------------------------------

export interface HelpModuleOmniboxResult extends OmniboxResult {
    keywordMatch: OmniboxMatch;
    typeName?: string;
    secondMatch?: OmniboxMatch;
    searchString?: string;
}

export const HelpModuleOmniboxResultTypeName = "HelpModuleOmniboxResult";

/** The four help entity types, in the order the export/import walks them (Signum's `ImportContents`). */
export const helpEntityTypes: Type<IHelpEntity>[] =
    [AppendixHelpEntity, NamespaceHelpEntity, TypeHelpEntity, QueryHelpEntity];

/**
 * Signum's `HelpLinkPrefix` — the one-letter tag of a `[t:Order]` link token inside a description. The
 * tokens are the ONE piece of Signum's wiki syntax that survives the move to a WYSIWYG editor: they are
 * environment-independent references, which a plain `<a href>` is not.
 */
export const HelpLinkPrefix = {
    type: "t",
    property: "p",
    query: "q",
    operation: "o",
    namespace: "n",
    appendix: "a",
} as const;
