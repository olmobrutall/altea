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
import { logAndBuildHttpError, type HttpError } from "@altea/altea/server/exceptionFilter";
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
//    advances row by row instead of at the end — but the headers are flushed by the FIRST LINE, never
//    before, so a failure with nothing yet written is still a plain HTTP error (see the route), and one
//    after that travels as an ImportErrorLine.

/** Signum's ImportFromExcelRequest. */
interface ImportFromExcelRequest {
    importModel: ImportExcelModel;
    queryRequest: WireQueryRequest;
}

/**
 * NEW here, with no Signum counterpart: the last line of a stream that failed after it had already
 * started. It is an `HttpError`, the same one the exception filter writes as a body, so the client can
 * raise it as the `ServiceError` every other failed call produces. Distinguishable from an ImportResult
 * by the single member — a result has none of it.
 */
export interface ImportErrorLine {
    importError: HttpError;
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

                // The response is COMMITTED by the first line, not before — everything the importer checks
                // up front (does the sheet's header row match the query's columns? is there a file at all?
                // are the match-by keys unique?) throws before any row exists, and those throws have to be
                // reportable. Flushing the headers first made them unreportable: the exception filter finds
                // `headersSent` and stands down, express's finalhandler destroys the socket, and the client
                // reads a stream that simply ended with no rows — an import that silently did nothing.
                let started = false;
                const startStream = (): void => {
                    if (started)
                        return;
                    started = true;
                    res.type("application/x-ndjson");
                    res.flushHeaders();
                };

                try {
                    for await (const result of ExcelImporter.importExcel(request, body.importModel, operation)) {
                        startStream();
                        res.write(Serializer.stringify(result) + "\n");
                    }
                } catch (e) {
                    // Nothing written yet → let it out, and the exception filter answers the ordinary JSON
                    // error body — the ONLY channel Signum's import has, and what its client is written to
                    // expect: ErrorModal, then the model dialog again so you can fix it and retry.
                    if (!started)
                        throw e;

                    // Already streaming → the status code is spent, so the failure travels as the LAST line
                    // and the client throws it (see ImportExcelProgressModal). Signum cannot report this
                    // case at all: its connection is simply aborted mid-array.
                    res.write(Serializer.stringify(
                        { importError: await logAndBuildHttpError(e, req) } satisfies ImportErrorLine) + "\n");
                    res.end();
                    return;
                }

                startStream(); // an import with no rows at all still has to answer something
                res.end();
            });
    }
}
