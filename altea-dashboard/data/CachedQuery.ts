import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, backReference, rowOrder, valueField, implementedBy, unit } from "@altea/altea/data/decorators";
import { Temporal, type int, type long } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { noRepeatValidator } from "@altea/altea/data/validators";
import { FilePathEmbedded, FileTypeSymbol } from "@altea/altea-files/data/Files";
import type { QueryRequest, ResultTable } from "@altea/altea/data/dynamicQuery/queryRequest";
import type { IUserAssetEntity } from "@altea/altea-user-assets/data/UserAssets";
import { DashboardEntity } from "./Dashboard";

// Port of Signum.Dashboard/CachedQuery.cs — ONE snapshot of the queries a dashboard needs, so opening it
// costs a file read instead of N queries. A row records which user assets the snapshot covers, the file
// holding the result tables, and what it cost to build.
//
// altea divergences:
//  - `MList<Lite<IUserAssetEntity>> UserAssets` → `@part` ROWS with a `@valueField` (altea's MList
//    replacement for a collection of lites). Signum's `[ImplementedBy()]` is EMPTY — the framework cannot
//    name the asset types, because @altea/altea-user-queries and @altea/altea-chart depend on THIS package,
//    not the other way round — so the APP widens it, exactly as it does for DashboardEntity_Part.content.
//  - `[DefaultFileType(...)]` has no counterpart (the note @altea/altea-whats-new already carries): a
//    FilePathEmbedded is given its type where it is CREATED, so DashboardLogic names CachedQueryFileType
//    when it writes one.
//  - `long QueryDuration` / `UploadDuration` → `int` ms, as every other duration column in altea.

/**
 * Signum's CachedQueryJS — what a snapshot FILE contains. Declared here, in the data layer, because both
 * ends read it: the server writes one per combined query, the browser parses it and evaluates each part's
 * query against it.
 *
 * `creationDate` is an ISO STRING, as Signum's generated `string /*DateTime*\/` is: a DTO is not an
 * entity, so nothing revives a Temporal value inside it (the call @altea/altea-whats-new documents).
 */
export interface CachedQueryJS {
    creationDate: string;
    queryRequest: QueryRequest;
    resultTable: ResultTable;
}

/** Signum's `[AutoInit] CachedQueryFileType`. */
export namespace CachedQueryFileType {
    export const CachedQuery: FileTypeSymbol = init();
}

/** One entry of CachedQueryEntity.userAssets (Signum's MList element). */
@reflect
@entity("Part")
export class CachedQueryEntity_UserAsset extends Entity {
    @backReference cachedQuery: Lite<CachedQueryEntity>;
    @rowOrder order: int;

    // Widened by the app (see the header) — the framework knows the INTERFACE, never the implementations.
    @valueField @implementedBy(() => [])
    userAsset: Lite<IUserAssetEntity>;
}

@reflect
@entity("System", "Master")
export class CachedQueryEntity extends Entity {

    dashboard: Lite<DashboardEntity>;

    // Signum's [PreserveOrder, NoRepeatValidator].
    @noRepeatValidator()
    userAssets: CachedQueryEntity_UserAsset[];

    file: FilePathEmbedded;

    numRows: int;

    numColumns: int;

    creationDate: Temporal.PlainDateTime = Clock.now;

    @unit("ms")
    // Signum declares both `long` (a millisecond count has no reason to be capped at 24 days).
    queryDuration: long;

    @unit("ms")
    uploadDuration: long;

    // NO toString override, as in Signum: a hand-written one would earn a ToStr column that its table
    // does not have, and the default (the type's nice name plus the id) is what a snapshot row wants
    // anyway — it is engine-written, never picked from a list.
}

/**
 * Signum's `DashboardWithCachedQueries` — what `/api/dashboard/:id` answers.
 *
 * Declared in the DATA layer, as every altea wire DTO is: it is the contract between the route and the
 * client, and neither half should own it. The snapshot ROWS travel here, not their contents — each one
 * carries a `file`, and the client downloads those separately (from wherever the file store points, which
 * is the point of the feature).
 */
export interface DashboardWithCachedQueries {
    dashboard: DashboardEntity;
    cachedQueries: CachedQueryEntity[];
}
