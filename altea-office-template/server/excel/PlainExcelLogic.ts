import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { WebBuilder } from "@altea/altea/server/webApi";
import { CustomType, attachmentDisposition } from "@altea/altea/server/webApi";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { parseQueryRequest } from "@altea/altea/server/queryServer";
import { getNiceName } from "@altea/altea/data/dynamicQuery/queryUtils";
import type { QueryRequest } from "@altea/altea/server/dynamicQuery/requests";
import type { QueryRequest as WireQueryRequest } from "@altea/altea/data/dynamicQuery/queryRequest";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { ExcelPermission } from "../../data/Excel";
import { PlainExcelGenerator } from "./PlainExcelGenerator";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";

// Port of the PLAIN-EXCEL half of Signum.Excel's ExcelLogic.cs + ExcelController.ToPlainExcel: export any
// query's rows to .xlsx, with the query's own columns as the header row.
//
// altea divergence: Signum had ONE `ExcelLogic.Start(sb, excelReport: bool)` covering plain export, the
// stored ExcelReport templates and the importer. This half is its own starter (as is the importer's — see
// ExcelImportLogic), so an app opts into exactly the features it wants and neither half can drag the
// other's routes in.
//
// Signum has ONE `ExcelLogic.Start`, and it registers the whole container
// (`PermissionLogic.RegisterTypes(typeof(ExcelPermission))`) — both PlainExcel and ImportFromExcel. altea
// split that start into two halves, so EACH half registers the container: an app that wires either one
// ends up with the pair of rows a Signum database has.

export namespace PlainExcelLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        PermissionLogic.registerContainer(ExcelPermission);

        if (sb.webBuilder)
            startServer(sb.webBuilder);
    }

    /**
     * Run the request and write the workbook.
     *
     * The permission is asserted HERE, not only in the route, so every caller is gated (Signum asserts in
     * the controller; the terminal / a scheduled task would bypass that).
     */
    export async function executePlainExcel(request: QueryRequest, title?: string, forImport = false): Promise<Uint8Array> {
        await assertPlainExcelAuthorized();

        const results = await QueryLogic.queries.executeQueryAsync(request);

        return PlainExcelGenerator.writePlainExcel(results, request, title ?? getNiceName(request.queryName), forImport);
    }

    async function assertPlainExcelAuthorized(): Promise<void> {
        if (!(await PermissionLogic.isAuthorized(ExcelPermission.PlainExcel)))
            throw new UnauthorizedAccessException(`Not authorized for '${ExcelPermission.PlainExcel.key}'`);
    }

    /** POST the same wire QueryRequest the SearchControl executes,
     *  get the .xlsx back as a download. `forImport` writes a file the importer can read back. */
    function startServer(ws: WebBuilder): void {
        ws.post("/api/excel/plain/:queryKey",
            { params: CustomType<{ queryKey: string }>(), req: CustomType<WireQueryRequest>() },
            async (req, res) => {
                const wire = await req.jsonTyped() as WireQueryRequest;
                const forImport = req.query.forImport === "true";

                const request = parseQueryRequest(wire);
                await QueryLogic.assertQueryAllowedHook?.(request.queryName, true);

                const bytes = await executePlainExcel(request, undefined, forImport);

                // Signum names the file `<queryKey><yyyyMMdd-HHmmss>.xlsx`.
                const fileName = `${wire.queryKey}${timestamp()}.xlsx`;
                res.setHeader("Content-Disposition", attachmentDisposition(fileName));
                res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(Buffer.from(bytes));
            });
    }
}

/** Signum's `Clock.Now.ToString("yyyyMMdd-HHmmss")` suffix. */
function timestamp(): string {
    const now = new Date();
    const p = (n: number, len = 2): string => String(n).padStart(len, "0");
    return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}
