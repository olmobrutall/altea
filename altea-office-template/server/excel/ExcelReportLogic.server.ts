import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { WebBuilder } from "@altea/altea/server/webApi";
import { CustomType, attachmentDisposition } from "@altea/altea/server/webApi";
import { table } from "@altea/altea/server/table";
import { retrieve } from "@altea/altea/server/Database";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { parseQueryRequest } from "@altea/altea/server/queryServer";
import type { QueryRequest } from "@altea/altea/server/dynamicQuery/requests";
import type { QueryRequest as WireQueryRequest } from "@altea/altea/data/dynamicQuery/queryRequest";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { getKey } from "@altea/altea/data/dynamicQuery/queryUtils";
import type { Lite } from "@altea/altea/data/lite";
import { ExcelReportEntity, ExcelReportOperation, extensionError } from "../../data/excel/ExcelReport";
import { ExcelReportGenerator } from "./ExcelReportGenerator.server";

// Port of the EXCEL-REPORT half of Signum.Excel's ExcelLogic.cs + the two ExcelController actions that
// serve it: list the reports registered for a query, and run one.
//
// See data/excel/ExcelReport.ts for what an ExcelReport is and why it exists beside this package's own
// xlsx templating.
//
// altea divergences:
//  - its own starter, like PlainExcelLogic's and ExcelImportLogic's, instead of Signum's single
//    `ExcelLogic.Start(sb, excelReport: bool)` flag — the same reason recorded there.
//  - the operations hang off the include (altea's fluent operations), where Signum chains
//    `.WithSave(...)` / `.WithDelete(...)` onto its own.
//  - the `.xlsx` extension check is a FIELD VALIDATION as well as Signum's run-time assert, so a template
//    with the wrong extension is refused when it is SAVED rather than the first time someone runs it.

export namespace ExcelReportLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(ExcelReportEntity)
            .withSave(ExcelReportOperation.Save)
            .withDelete(ExcelReportOperation.Delete)
            // Signum names its four query columns in the include (`WithQuery(() => s => new { … })`);
            // altea's server `withQuery()` takes no projection, so the same four are the CLIENT default
            // columns — see ExcelClient.
            .withQuery();

        if (sb.webBuilder)
            startServer(sb.webBuilder);
    }

    /** Signum's `GetExcelReports(queryName)` — the reports a query's Excel menu offers. */
    export async function getExcelReports(queryName: QueryName): Promise<Lite<ExcelReportEntity>[]> {
        const key = getKey(queryName);

        const reports = await table(ExcelReportEntity)
            .filter(er => er.query.key == key)
            .toArray() as ExcelReportEntity[];

        return reports.map(er => er.toLite());
    }

    /** Signum's `ExecuteExcelReportAsync` — run the query, refill the stored template with its rows. */
    export async function executeExcelReport(
        excelReport: Lite<ExcelReportEntity>, request: QueryRequest,
    ): Promise<{ report: ExcelReportEntity; bytes: Uint8Array }> {
        const results = await QueryLogic.queries.executeQueryAsync(request);

        const report = await retrieve(ExcelReportEntity, excelReport.id);
        assertExtension(report);

        return { report, bytes: ExcelReportGenerator.writeDataInExcelFile(results, request, report.file.binaryFile) };
    }

    /**
     * Signum's `AsserExtension` [sic] — the generator opens the file as an OOXML package, so anything but
     * an .xlsx fails deep inside the zip reader with a message about parts and relationships. This is the
     * same check placed where it can say what is actually wrong.
     */
    export function assertExtension(report: ExcelReportEntity): void {
        const error = extensionError(report.file);
        if (error != undefined)
            throw new Error(error);
    }

    function startServer(ws: WebBuilder): void {

        /** Signum's `ExcelController.GetExcelReports`. */
        ws.get("/api/excel/reportsFor/:queryKey",
            {
                params: CustomType<{ queryKey: string }>(),
                res: CustomType<Lite<ExcelReportEntity>[]>(),
            },
            async (req, res) => {
                const queryName = QueryLogic.tryGetQueryNameByKey(req.params.queryKey);
                if (queryName == undefined)
                    throw new Error(`Query '${req.params.queryKey}' not found`);

                await QueryLogic.assertQueryAllowedHook?.(queryName, true);
                res.jsonTyped(await getExcelReports(queryName));
            });

        /** Signum's `ExcelController.GenerateExcelReport`. */
        ws.post("/api/excel/excelReport/:queryKey",
            {
                params: CustomType<{ queryKey: string }>(),
                req: CustomType<ExcelReportRequest>(),
            },
            async (req, res) => {
                const body = await req.jsonTyped();

                const request = parseQueryRequest(body.queryRequest);
                await QueryLogic.assertQueryAllowedHook?.(request.queryName, true);

                const { report, bytes } = await executeExcelReport(body.excelReport, request);

                // Signum names the file `<report>-<yyyyMMdd-HHmmss>.xlsx`.
                const fileName = `${report.displayName}-${timestamp()}.xlsx`;
                res.setHeader("Content-Disposition", attachmentDisposition(fileName));
                res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                    .send(Buffer.from(bytes));
            });
    }
}

/** Signum's `ExcelReportRequest` — the report to run, and the search that feeds it. */
export interface ExcelReportRequest {
    queryRequest: WireQueryRequest;
    excelReport: Lite<ExcelReportEntity>;
}

/** Signum's `Clock.Now.ToString("yyyyMMdd-HHmmss")` suffix. */
function timestamp(): string {
    const now = new Date();
    const p = (n: number, len = 2): string => String(n).padStart(len, "0");
    return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}
