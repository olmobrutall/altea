import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { WebBuilder } from "@altea/altea/server/webApi";
import { CustomType } from "@altea/altea/server/webApi";
import { Serializer } from "@altea/altea/data/serializer";
import { Entity, type Type } from "@altea/altea/data/entity";
import { resolveCleanType } from "@altea/altea/data/registration";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { OperationSymbol } from "@altea/altea/data/operations";
import { OperationLogic } from "@altea/altea/server/operationLogic";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { parseQueryRequest } from "@altea/altea/server/queryServer";
import type { QueryRequest as WireQueryRequest } from "@altea/altea/data/dynamicQuery/queryRequest";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { ExcelPermission, type ImportExcelModel } from "../../data/Excel";
import { ExcelImporter } from "./ExcelImporter.server";

// Port of the IMPORT half of Signum.Excel's ExcelLogic.cs + ExcelController (ValidateForImport /
// ImportFromExcel) — its own starter, separate from PlainExcelLogic's (see the note there).
//
// altea divergences:
//  - `ValidateForImport` returned a `QueryTokenTS` DTO; altea has no query-token DTO (tokens are resolved
//    CLIENT-side from the reflection metadata), so the route answers with the top collection element's
//    token STRING — which is all the client does with it (it offers that collection in the model).
//  - The import RESPONSE is newline-delimited JSON, one ImportResult per line, exactly what Signum's
//    `IAsyncEnumerable<ImportResult>` produced on the wire and what the client's `jsonObjectStream` reads.
//    Buffering is disabled per line (`res.flushHeaders()` + a write per result) so the progress modal
//    advances row by row instead of at the end.

/** Signum's ImportFromExcelRequest. */
interface ImportFromExcelRequest {
    importModel: ImportExcelModel;
    queryRequest: WireQueryRequest;
}

export namespace ExcelImportLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        if (sb.webBuilder)
            startServer(sb.webBuilder);
    }

    async function assertImportAuthorized(): Promise<void> {
        if (!(await PermissionAuthLogic.isAuthorized(ExcelPermission.ImportFromExcel)))
            throw new UnauthorizedAccessException(`Not authorized for '${ExcelPermission.ImportFromExcel.key}'`);
    }

    /**
     * Signum's `ImportFromExcelRequest.GetOperationSymbol`: resolve the operation key and assert it is
     * allowed for the entity type, so a caller cannot smuggle in an operation the role may not run.
     */
    async function resolveSaveOperation(operationKey: string, entityType: Type<Entity>): Promise<OperationSymbol> {
        const symbol = SymbolLogic.tryToSymbol(OperationSymbol, operationKey);
        if (symbol == undefined)
            throw new Error(`Operation '${operationKey}' is not registered`);

        await OperationLogic.assertOperationAllowed(symbol, entityType, true, null);
        return symbol;
    }

    function startServer(ws: WebBuilder): void {

        // Signum's ValidateForImport: can this query request drive an import? Throws with the reason if not,
        // else answers the top collection element's token (or null when there is no collection).
        ws.post("/api/excel/validateForImport/:queryKey",
            { params: CustomType<{ queryKey: string }>(), req: CustomType<WireQueryRequest>(), res: CustomType<string | null>() },
            async (req, res) => {
                await assertImportAuthorized();

                const request = parseQueryRequest(await req.jsonTyped() as WireQueryRequest);
                await QueryLogic.assertQueryAllowedHook?.(request.queryName, true);

                const parsed = await ExcelImporter.parseQueryRequest(request);
                res.jsonTyped(parsed.elementTopToken?.fullKey() ?? null);
            });

        // Signum's ImportFromExcel: apply the file and stream one result per entity.
        ws.post("/api/excel/import/:queryKey",
            { params: CustomType<{ queryKey: string }>(), req: CustomType<ImportFromExcelRequest>() },
            async (req, res) => {
                await assertImportAuthorized();

                const body = await req.jsonTyped() as ImportFromExcelRequest;
                const request = parseQueryRequest(body.queryRequest);
                await QueryLogic.assertQueryAllowedHook?.(request.queryName, true);

                const mainType = resolveCleanType(body.importModel.typeName) as Type<Entity> | undefined;
                if (mainType == undefined)
                    throw new Error(`Type '${body.importModel.typeName}' is not registered`);

                const operation = await resolveSaveOperation(body.importModel.operationKey, mainType);

                res.type("application/x-ndjson");
                res.flushHeaders();

                for await (const result of ExcelImporter.importExcel(request, body.importModel, operation))
                    res.write(Serializer.stringify(result) + "\n");

                res.end();
            });
    }
}
