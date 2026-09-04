import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ajaxGet, ajaxPost, ajaxPostRaw, saveFile, type WebApiHttpError } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Finder } from "@altea/altea/client/Finder";
import { QueryString } from "@altea/altea/client/QueryString";
import type { TypeInfo } from "@altea/altea/client/Reflection";
import type { QueryRequest } from "@altea/altea/data/dynamicQuery/queryRequest";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { ChartClient } from "@altea/altea-chart/client/ChartClient";
import { ChartPermission } from "@altea/altea-chart/data/ChartPermissions";
import { ExcelMessage, ExcelPermission, ImportExcelModel } from "../data/Excel";
import { ExcelReportEntity } from "../data/excel/ExcelReport";
import ExcelMenu from "./ExcelMenu";
import { ImportExcelProgressModal } from "./ImportExcelProgressModal";

// Port of Signum.Excel's ExcelClient.tsx — the CLIENT half of all three Excel features: "export this
// query to .xlsx", "import an .xlsx back into entities", and the stored ExcelReport templates. It lives in
// @altea/altea-office-template because its server half does; Signum keeps Signum.Excel and Signum.Word
// apart, and the two would be separate packages here too were it not that the report generator, the plain
// exporter and the xlsx templating all sit on this package's one OOXML substrate.
//
// altea divergences:
//  - `Navigator.addSettings(new EntitySettings(...))` → `cb.configure(T).withView(...)`.
//  - `isPermissionAuthorized` lives on @altea/altea-auth's AuthClient, not in core AppContext.
//  - `ChangeLogClient.registerChangeLogModule` has no counterpart.
//  - the report list is gated on the SAVE operation reaching the client (Signum's `tryOperationInfo`),
//    which is what hides "Administer" / "Create new" from a role that may only RUN a report.

export namespace ExcelClient {

    export function start(
        cb: ClientBuilder, options: { plainExcel: boolean; importFromExcel: boolean; excelReport?: boolean },
    ): void {

        if (options.importFromExcel)
            cb.configure(ImportExcelModel).withView(() => import("./Templates/ImportExcelModel"));

        if (options.excelReport)
            cb.configure(ExcelReportEntity)
                .withView(() => import("./Templates/ExcelReport"))
                // Signum's four include columns, which its server `WithQuery(() => s => new { … })` names;
                // altea's server withQuery takes no projection, so they are declared here.
                .withQuerySettings(token => ({
                    defaultColumns: [
                        token(a => a.id),
                        token(a => a.query),
                        token(a => a.file.fileName),
                        token(a => a.displayName),
                    ],
                }));

        Finder.ButtonBarQuery.onButtonBarElements().push(ctx => {

            if (!ctx.searchControl.props.showBarExtension ||
                !(ctx.searchControl.props.showBarExtensionOption?.showExcelMenu ?? ctx.searchControl.props.largeToolbarButtons))
                return undefined;

            const plainExcel = options.plainExcel && AuthClient.isPermissionAuthorized(ExcelPermission.PlainExcel);
            const importFromExcel = options.importFromExcel && AuthClient.isPermissionAuthorized(ExcelPermission.ImportFromExcel);
            const excelReport = options.excelReport === true;

            if (!plainExcel && !importFromExcel && !excelReport)
                return undefined;

            return {
                button: <ExcelMenu searchControl={ctx.searchControl} plainExcel={plainExcel}
                    importFromExcel={importFromExcel} excelReport={excelReport} />,
            };
        });

        // The same export, from the CHART page's toolbar: a chart request IS a query request, so the rows
        // behind the drawing are exportable exactly as a search's are (Signum's ButtonBarChart entry).
        if (options.plainExcel) {
            ChartClient.ButtonBarChart.onButtonBarElements().push(ctx => {
                if (!AuthClient.isPermissionAuthorized(ChartPermission.ViewCharting) ||
                    !AuthClient.isPermissionAuthorized(ExcelPermission.PlainExcel))
                    return undefined;

                return (
                    <button
                        className="sf-query-button sf-chart-script-edit btn btn-tertiary"
                        type="button"
                        onClick={() => API.generatePlainExcel(ChartClient.API.getRequest(ctx.chartRequestView.chartRequest))}>
                        <FontAwesomeIcon aria-hidden={true} icon="file-excel" /> &nbsp; {ExcelMessage.ExportToExcel.niceToString()}
                    </button>
                );
            });
        }
    }

    export namespace API {

        /** POST the same wire QueryRequest the SearchControl executes, save the .xlsx it answers with.
         *  `forImport` asks for the shape the importer can read back (Signum's DownloadTemplate). */
        export function generatePlainExcel(request: QueryRequest, overrideFileName?: string, forImport?: boolean): void {
            void ajaxPostRaw({ url: "/api/excel/plain/" + request.queryKey + "?" + QueryString.stringify({ forImport }) }, request)
                .then(response => saveFile(response, overrideFileName));
        }

        /** Signum's `forQuery` — the reports registered for a query, for the menu. */
        export function forQuery(queryKey: string): Promise<Lite<ExcelReportEntity>[]> {
            return ajaxGet({ url: "/api/excel/reportsFor/" + queryKey });
        }

        /** Signum's `generateExcelReport` — run one, save the .xlsx it answers with. */
        export function generateExcelReport(request: QueryRequest, excelReport: Lite<ExcelReportEntity>): void {
            void ajaxPostRaw({ url: "/api/excel/excelReport/" + request.queryKey },
                { queryRequest: request, excelReport })
                .then(response => saveFile(response));
        }

        /** Signum's ValidateForImport. altea has no query-token DTO, so the route answers the top collection
         *  element's token STRING (or null) rather than a QueryTokenTS — see ExcelImportLogic. */
        export function validateForImport(queryRequest: QueryRequest): Promise<string | null> {
            return ajaxPost({ url: "/api/excel/validateForImport/" + queryRequest.queryKey }, queryRequest);
        }

        export function importFromExcel(qr: QueryRequest, model: ImportExcelModel, type: TypeInfo): Promise<ImportFromExcelReport> {
            const abortController = new AbortController();
            return ImportExcelProgressModal.show(abortController, type,
                () => ajaxPostRaw({ url: "/api/excel/import/" + qr.queryKey, signal: abortController.signal },
                    { importModel: model, queryRequest: qr } satisfies ImportFromExcelRequest));
        }
    }

    /** Signum's ImportFromExcelRequest / ImportResult / ImportFromExcelReport — the wire shapes of the
     *  import route (the results arrive one per NDJSON line, see ImportExcelProgressModal). */
    export interface ImportFromExcelRequest {
        importModel: ImportExcelModel;
        queryRequest: QueryRequest;
    }

    export interface ImportResult {
        totalRows: number;
        rowIndex: string;
        entity?: Lite<Entity>;
        action: ImportActionKeys;
        error?: string;
    }

    export type ImportActionKeys = "Updated" | "Inserted" | "NoChanges";

    /** NEW here, with no Signum counterpart — see ExcelImportLogic's ImportErrorLine: the last line of a
     *  stream that failed after it had already started, carrying the HttpError a failure BEFORE the first
     *  line would have come back as. ImportExcelProgressModal raises it as a ServiceError. */
    export interface ImportErrorLine {
        importError: WebApiHttpError;
    }

    export interface ImportFromExcelReport {
        results: ImportResult[];
        error?: any;
    }
}

declare module "@altea/altea/client/SearchControl/SearchControlLoaded" {
    interface ShowBarExtensionOption {
        showExcelMenu?: boolean;
    }
}
