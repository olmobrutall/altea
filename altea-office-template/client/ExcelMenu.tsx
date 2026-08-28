import * as React from "react";
import { Dropdown } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import SelectorModal from "@altea/altea/client/SelectorModal";
import "@altea/altea/client/AppContext"; // String.prototype.formatHtml
import type SearchControlLoaded from "@altea/altea/client/SearchControl/SearchControlLoaded";
import { SearchMessage } from "@altea/altea/data/uiMessages";
import type { PaginationMode } from "@altea/altea/client/FindOptions";
import type { QueryRequest } from "@altea/altea/data/dynamicQuery/queryRequest";
import { ExcelMessage, ImportFromExcelMessage } from "../data/Excel";
import { ExcelClient } from "./ExcelClient";

// Port of Signum.Excel's ExcelMenu.tsx — the SearchControl toolbar entry for the two Excel features.
//
// altea divergences: ExcelReportEntity is not ported (see ExcelClient's header), so the report list and its
// "Administer" / "Create new" items are gone, and with them Signum's `addDropdownDividers` helper — the menu
// is two fixed items. What survives unchanged is `selectPagination`, the "current page or all pages?" question
// an export has to ask, which the import model's DownloadTemplate button reuses.

export interface ExcelMenuProps {
    searchControl: SearchControlLoaded;
    plainExcel: boolean;
    importFromExcel: boolean;
}

export default function ExcelMenu(p: ExcelMenuProps): React.JSX.Element {

    async function handlePlainExcel(): Promise<void> {
        const request = await selectPagination(p.searchControl);
        if (request != null)
            ExcelClient.API.generatePlainExcel(request);
    }

    async function handleImportFromExcel(): Promise<void> {
        const ImportExcelModel = await import("./Templates/ImportExcelModel");
        await ImportExcelModel.onImportFromExcel(p.searchControl);
    }

    const label = (
        <span>
            <FontAwesomeIcon aria-hidden={true} icon="file-excel" />
            {p.searchControl.props.largeToolbarButtons === true
                ? <span className="d-none d-sm-inline">{" " + ExcelMessage.ExportToExcel.niceToString()}</span>
                : undefined}
        </span>
    );

    // Signum's single-feature shortcut: with nothing to choose between, the menu IS the export button.
    if (p.plainExcel && !p.importFromExcel)
        return (
            <button className="sf-query-button sf-search btn btn-tertiary" title={ExcelMessage.ExportToExcel.niceToString()}
                onClick={() => void handlePlainExcel()}>
                {label}
            </button>
        );

    return (
        <Dropdown title={ExcelMessage.ExportToExcel.niceToString()}>
            <Dropdown.Toggle id="excelDropDown" variant="tertiary">
                {label}
            </Dropdown.Toggle>
            <Dropdown.Menu>
                {p.plainExcel &&
                    <Dropdown.Item onClick={() => void handlePlainExcel()}>
                        <FontAwesomeIcon aria-hidden={true} icon="file-excel" className="me-2" />
                        {ExcelMessage.ExportToExcel.niceToString()}
                    </Dropdown.Item>}
                {p.importFromExcel &&
                    <Dropdown.Item onClick={() => void handleImportFromExcel()}>
                        <FontAwesomeIcon aria-hidden={true} icon="file-excel" className="me-2" />
                        {ImportFromExcelMessage.ImportFromExcel.niceToString()}
                    </Dropdown.Item>}
            </Dropdown.Menu>
        </Dropdown>
    );
}

/**
 * Signum's `selectPagination`: an export writes what the REQUEST says, so a paginated search has to be asked
 * whether it means this page or all of them. Answered without a question when the current page already holds
 * every row.
 */
export async function selectPagination(sc: SearchControlLoaded): Promise<QueryRequest | undefined> {
    const request = sc.getQueryRequest(true);
    const rt = sc.state.resultTable;

    if (request.pagination.mode !== "Firsts" &&
        !(request.pagination.mode === "Paginate" && (rt == null || rt.totalElements! > rt.rows.length)))
        return request;

    const pm = await SelectorModal.chooseElement<PaginationMode>([request.pagination.mode, "All"], {
        title: ExcelMessage.ExportToExcel.niceToString(),
        message: ExcelMessage.WhatDoYouWantToExport.niceToString(),
        buttonDisplay: a => <span>
            {a === "All" ? SearchMessage.AllPages.niceToString() : SearchMessage.CurrentPage.niceToString()}{" "}
            ({rt && SearchMessage._0Results_N.niceToString().forGenderAndNumber(a === "All" ? rt.totalElements : rt.rows.length)
                .formatHtml(<strong>{a === "All" ? rt.totalElements : rt.rows.length}</strong>)})
        </span>,
        buttonName: a => a,
        size: "md",
    });

    if (pm == undefined)
        return undefined;

    if (pm === "All")
        request.pagination = { mode: "All" };

    return request;
}
