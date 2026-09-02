import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import { table } from "@altea/altea/server/table";
import { withQuoted } from "@altea/altea/data/decorators";
import type { IQuery } from "@altea/altea/data/iquery";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { FileTypeLogic } from "@altea/altea-files/server/FileTypeLogic.server";
import type { IFileTypeAlgorithm } from "@altea/altea-files/server/FileTypeAlgorithm.server";
import { DashboardEntity } from "../data/Dashboard";
import { CachedQueryEntity, CachedQueryEntity_UserAsset, CachedQueryFileType } from "../data/CachedQuery";

// Port of the CachedQuery half of Signum.Dashboard/DashboardLogic.cs — the SNAPSHOT side of a dashboard:
// one file per combined query, so opening the dashboard costs a file read (from wherever the file store
// points — disk, S3, Azure) instead of N database queries, and every part then evaluates its own query
// against that snapshot IN THE BROWSER.
//
// This module owns the table and the file type. The REGENERATION (which builds the snapshots) and the
// client-side executor (which reads them) are the other two halves — see the port notes below.

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
    }

    /** Every snapshot row of a dashboard, newest first — what the client's fetch turns into file downloads. */
    export async function getCachedQueries(dashboard: DashboardEntity): Promise<CachedQueryEntity[]> {
        return await table(CachedQueryEntity)
            .filter(cq => cq.dashboard.is(dashboard))
            .orderByDescending(cq => cq.creationDate)
            .toArray() as CachedQueryEntity[];
    }
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
