import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ajaxPost, ajaxPostRaw, saveFile, type WebApiHttpError } from "@altea/altea/client/Services";
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
import ExcelMenu from "./ExcelMenu";
import { ImportExcelProgressModal } from "./ImportExcelProgressModal";

// Port of Signum.Excel's ExcelClient.tsx — the CLIENT half of the two Excel features this package already
// serves (see data/Excel.ts and server/excel/): "export this query to .xlsx" and "import an .xlsx back into
// entities". It lives in @altea/altea-office-template because its server half does; Signum keeps
// Signum.Excel and Signum.Word apart, but the template-driven ExcelReport half — the only part that
// justified a separate module — is deliberately not ported (an .xlsx OfficeTemplate is strictly more
// capable), so the remaining pieces travel with the code that answers their routes.
//
// altea divergences:
//  - `options.excelReport` is gone with ExcelReportEntity, and with it the report list, "Administer" and
//    "Create new". What is left is a two-item menu (export / import) that collapses to a single BUTTON when
//    only export is enabled — which is Signum's own `plainExcel && !excelReport && !importFromExcel` branch.
//  - `Navigator.addSettings(new EntitySettings(...))` → `cb.configure(T).withView(...)`.
//  - `isPermissionAuthorized` lives on @altea/altea-auth's AuthClient, not in core AppContext.
//  - `ChangeLogClient.registerChangeLogModule` has no counterpart.

export namespace ExcelClient {

    export function start(cb: ClientBuilder, options: { plainExcel: boolean; importFromExcel: boolean }): void {

        if (options.importFromExcel)
            cb.configure(ImportExcelModel).withView(() => import("./Templates/ImportExcelModel"));

        Finder.ButtonBarQuery.onButtonBarElements().push(ctx => {

            if (!ctx.searchControl.props.showBarExtension ||
                !(ctx.searchControl.props.showBarExtensionOption?.showExcelMenu ?? ctx.searchControl.props.largeToolbarButtons))
                return undefined;

            const plainExcel = options.plainExcel && AuthClient.isPermissionAuthorized(ExcelPermission.PlainExcel);
            const importFromExcel = options.importFromExcel && AuthClient.isPermissionAuthorized(ExcelPermission.ImportFromExcel);

            if (!plainExcel && !importFromExcel)
                return undefined;

            return {
                button: <ExcelMenu searchControl={ctx.searchControl} plainExcel={plainExcel} importFromExcel={importFromExcel} />,
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
        action: ImportAction;
        error?: string;
    }

    export type ImportAction = "Updated" | "Inserted" | "NoChanges";

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
