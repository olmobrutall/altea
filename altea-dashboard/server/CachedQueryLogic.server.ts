import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import "@altea/altea/server/fluentOperations"; // FluentInclude.withOperations
import { table } from "@altea/altea/server/table";
import { deleteList } from "@altea/altea/server/Database";
import { withQuoted } from "@altea/altea/data/decorators";
import type { IQuery } from "@altea/altea/data/iquery";
import { Clock } from "@altea/altea/data/utils/clock";
import { ValidationMessage } from "@altea/altea/data/validators";
import { type int } from "@altea/altea/data/basics";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { Pagination, QueryRequest } from "@altea/altea/server/dynamicQuery/requests";
import { toWireQueryRequest, toWireResultTable } from "@altea/altea/server/queryServer";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { FileTypeLogic } from "@altea/altea-files/server/FileTypeLogic.server";
import type { IFileTypeAlgorithm } from "@altea/altea-files/server/FileTypeAlgorithm.server";
import { FilePathEmbedded } from "@altea/altea-files/data/Files";
import { FilePathEmbeddedLogic } from "@altea/altea-files/server/FilePathEmbeddedLogic.server";
import { DashboardEntity, DashboardOperation, type DashboardEntity_Part } from "../data/Dashboard";
import { CachedQueryEntity, CachedQueryEntity_UserAsset, CachedQueryFileType, type CachedQueryJS } from "../data/CachedQuery";
import { partConfigs } from "./DashboardLogic.server";
import {
    getCachedQueryDefinitions, combineCachedQueryDefinitions, type CachedQueryDefinition,
} from "./CachedQueryDefinitions.server";

// Port of the CachedQuery half of Signum.Dashboard/DashboardLogic.cs — the SNAPSHOT side of a dashboard:
// one file per combined query, so opening the dashboard costs a file read (from wherever the file store
// points — disk, S3, Azure) instead of N database queries, and every part then evaluates its own query
// against that snapshot IN THE BROWSER.
//
// This module owns the table, the file type and the REGENERATION. The client-side executor that reads a
// snapshot is the remaining half.
//
// altea divergences:
//  - Signum wraps each regenerating query in `Connector.CommandTimeoutScope(cq.TimeoutForQueries)`; altea's
//    Connector has no command-timeout scope, so that configured value is inert (see the entity).
//  - a snapshot of HISTORY is REFUSED rather than written: a request carrying a SystemTime answers "as of"
//    a moment, and a file cannot be re-asked with a different one, so caching it would freeze an answer
//    whose question is no longer visible. Signum does not check, having no case that produces one.

export namespace CachedQueryLogic {

    /**
     * `fileTypeAlgorithm` is Signum's `cachedQueryAlgorithm` parameter of DashboardLogic.Start: the APP
     * decides where a snapshot lives (a local folder, an S3 bucket, an Azure container), exactly as it does
     * for every other file type — which is the whole point of putting the calculation on the client, since
     * the file can then be served by storage rather than by the app.
     */
    export function start(sb: SchemaBuilder, options: { fileTypeAlgorithm: IFileTypeAlgorithm }): void {
        if (sb.alreadyDefined(start))
            return;

        FileTypeLogic.register(CachedQueryFileType.CachedQuery, options.fileTypeAlgorithm);

        sb.include(CachedQueryEntity)
            .withQuery();

        // Signum's `QueryLogic.Expressions.Register((DashboardEntity db) => db.CachedQueries())`.
        QueryLogic.expressions.register(DashboardEntity, (db: DashboardEntity) => db.cachedQueries!(),
            { key: "CachedQueries", niceName: () => CachedQueryEntity.nicePluralName() });

        // Signum registers RegenerateCachedQueries inside its DashboardGraph; altea hangs it off the
        // include DashboardLogic already opened — `sb.include` is idempotent, so reaching a type another
        // module included needs nothing more.
        sb.include(DashboardEntity).withOperations(op => {
            op.withExecute(DashboardOperation.RegenerateCachedQueries, {
                // Signum's CanExecute: there is nothing to regenerate without a configuration.
                canExecute: db => db.cacheQueryConfiguration == null
                    ? ValidationMessage._0IsNotSet.niceToString(
                        DashboardEntity.nicePropertyName(a => a.cacheQueryConfiguration))
                    : null,
                // NOT ported: Signum's `ForReadonlyEntity = true`, which offers the operation on an entity
                // the user may only READ — regenerating replaces the SNAPSHOTS, not the dashboard, so it is
                // a legitimate thing for a reader to do. altea's ExecuteOptions has no such flag, so the
                // operation follows the ordinary rule and needs write access to the dashboard.
                execute: db => regenerate(db),
            });
        });
    }

    /** Every snapshot row of a dashboard, newest first — what the client's fetch turns into file downloads. */
    export async function getCachedQueries(dashboard: DashboardEntity): Promise<CachedQueryEntity[]> {
        return await table(CachedQueryEntity)
            .filter(cq => cq.dashboard.is(dashboard))
            .orderByDescending(cq => cq.creationDate)
            .toArray() as CachedQueryEntity[];
    }

    /**
     * Signum's RegenerateCachedQueries body — replace every snapshot of this dashboard.
     *
     * The ordering is Signum's and it matters: the old rows and their files go FIRST, because a snapshot is
     * addressed by the user assets it covers, and two generations would both answer for the same asset.
     */
    export async function regenerate(db: DashboardEntity): Promise<void> {
        const config = db.cacheQueryConfiguration!;
        const maxRows = config.maxRows as number;

        const old = await getCachedQueries(db);
        for (const cq of old)
            FilePathEmbeddedLogic.deleteFileOnCommit(cq.file);
        await deleteList(old);

        const combined = combineCachedQueryDefinitions(getCachedQueryDefinitions(db, definitionsOfPart));

        for (const c of combined) {
            if (c.queryRequest.systemTime != null)
                throw new Error("Cannot cache a query with a SystemTime: "
                    + c.userAssets.map(a => a.key()).join(", "));

            // Signum: a request that wants EVERYTHING is run with one row MORE than the ceiling, so "there
            // were too many" is distinguishable from "there were exactly that many".
            const wantsAll = c.queryRequest.pagination instanceof Pagination.All;
            const request = !wantsAll ? c.queryRequest
                : new QueryRequest(c.queryRequest.queryName, c.queryRequest.filters, c.queryRequest.orders,
                    c.queryRequest.columns, new Pagination.Firsts(maxRows + 1), c.queryRequest.groupResults,
                    c.queryRequest.systemTime);

            const now = Clock.now;

            const queryStarted = Date.now();
            const resultTable = await QueryLogic.queries.executeQueryAsync(request);
            const queryDuration = Date.now() - queryStarted;

            if (wantsAll && resultTable.rows.length > maxRows)
                throw new Error("The query for " + c.userAssets.map(a => a.key()).join(", ")
                    + " has returned more than " + maxRows + " rows");

            const uploadStarted = Date.now();

            const wire = toWireQueryRequest(c.queryRequest);
            const json: CachedQueryJS = {
                creationDate: now.toString(),
                queryRequest: wire,
                // The stored table declares the pagination the REQUEST asked for, not the one used to fetch
                // it: a snapshot of "everything" is what lets the browser page and filter it freely.
                resultTable: { ...toWireResultTable(resultTable, wire), pagination: wire.pagination },
            };

            const file = FilePathEmbedded.create({
                fileType: CachedQueryFileType.CachedQuery,
                fileName: "CachedQuery.json",
                binaryFile: new TextEncoder().encode(JSON.stringify(json)),
            });
            file.prepareForSave();

            const uploadDuration = Date.now() - uploadStarted;

            const row = CachedQueryEntity.create({
                dashboard: db.toLite(),
                creationDate: now,
                file,
                // Signum's `qr.Columns.Count + (qr.GroupResults ? 0 : 1)` — a non-grouping result also
                // carries the row ENTITY, which is a column the request does not name.
                numColumns: (c.queryRequest.columns.length + (c.queryRequest.groupResults ? 0 : 1)) as int,
                numRows: resultTable.rows.length as int,
                queryDuration: queryDuration as int,
                uploadDuration: uploadDuration as int,
            });
            row.userAssets = c.userAssets.map((ua, i) => CachedQueryEntity_UserAsset.create({
                cachedQuery: row.toLite(),
                order: i as int,
                userAsset: ua,
            }));

            await row.save();
        }
    }
}

/** Signum's `OnGetCachedQueryDefinition.Invoke(p.Content, p)` — dispatch to the part's own config. */
function definitionsOfPart(part: DashboardEntity_Part): CachedQueryDefinition[] {
    const config = partConfigs().find(c => part.content instanceof c.type);
    return config?.getCachedQueryDefinitions?.(part.content, part) ?? [];
}

// Signum's `DashboardLogic.CachedQueries(this DashboardEntity db)` — a `withQuoted` prototype member plus
// the registration above, which is how altea spells an [AutoExpressionField] extension method.
declare module "../data/Dashboard" {
    interface DashboardEntity {
        cachedQueries?(): IQuery<CachedQueryEntity>;
    }
}

DashboardEntity.prototype.cachedQueries = withQuoted(function (this: DashboardEntity): IQuery<CachedQueryEntity> {
    return table(CachedQueryEntity).filter(cq => cq.dashboard.is(this));
});

// Keep the row type reachable from this module, so a caller needs only one import.
export { CachedQueryEntity, CachedQueryEntity_UserAsset, CachedQueryFileType };
