import * as React from "react";
import { Dropdown } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import SelectorModal from "@altea/altea/client/SelectorModal";
import "@altea/altea/client/AppContext"; // String.prototype.formatHtml
import type SearchControlLoaded from "@altea/altea/client/SearchControl/SearchControlLoaded";
import { Finder } from "@altea/altea/client/Finder";
import { Navigator } from "@altea/altea/client/Navigator";
import { getOperationInfos } from "@altea/altea/client/Reflection";
import { SearchMessage } from "@altea/altea/data/uiMessages";
import type { PaginationModeKeys } from "@altea/altea/client/FindOptions";
import type { QueryRequest } from "@altea/altea/data/dynamicQuery/queryRequest";
import type { Lite } from "@altea/altea/data/lite";
import { ExcelMessage, ImportFromExcelMessage } from "../data/Excel";
import { ExcelReportEntity, ExcelReportOperation } from "../data/excel/ExcelReport";
import { ExcelClient } from "./ExcelClient";

// Port of Signum.Excel's ExcelMenu.tsx — see port/OfficeTemplate.md.
//
// The SearchControl toolbar entry for the two Excel features.
//
// The menu has up to three sections, separated by dividers: the plain export, the import, and the stored
// ExcelReports for this query (each one an item that runs it, plus "Administer" and "Create new" for
// whoever may edit them). With only the export enabled it collapses to a single BUTTON — Signum's own
// `plainExcel && !excelReport && !importFromExcel` branch.
//
// altea divergences:
//  - the report list is loaded LAZILY, on the first open, so a
//    search page costs no extra request until someone looks.
//  - `ExcelReportEntity.tryOperationInfo(Save)` becomes `Operations.tryOperationInfo` — altea keeps the
//    per-role operation list in the metadata blob rather than on the Type.
//
// `selectPagination` is unchanged: the "current page or all pages?" question an export has to ask, which
// the import model's DownloadTemplate button reuses.

export interface ExcelMenuProps {
    searchControl: SearchControlLoaded;
    plainExcel: boolean;
    importFromExcel: boolean;
    excelReport: boolean;
}

export default function ExcelMenu(p: ExcelMenuProps): React.JSX.Element {

    const [isOpen, setIsOpen] = React.useState(false);
    const [excelReports, setExcelReports] = React.useState<Lite<ExcelReportEntity>[] | undefined>(undefined);

    const queryKey = p.searchControl.props.findOptions.queryKey;

    function handleToggle(): void {
        // The reports are fetched the first time the menu opens, not on every render of the search page.
        if (!isOpen && excelReports == undefined && p.excelReport)
            void reloadExcelReports();

        setIsOpen(!isOpen);
    }

    async function reloadExcelReports(): Promise<void> {
        setExcelReports(await ExcelClient.API.forQuery(queryKey));
    }

    async function handlePlainExcel(): Promise<void> {
        const request = await selectPagination(p.searchControl);
        if (request != null)
            ExcelClient.API.generatePlainExcel(request);
    }

    async function handleExcelReport(report: Lite<ExcelReportEntity>): Promise<void> {
        const request = await selectPagination(p.searchControl);
        if (request != null)
            ExcelClient.API.generateExcelReport(request, report);
    }

    async function handleImportFromExcel(): Promise<void> {
        const ImportExcelModel = await import("./Templates/ImportExcelModel");
        await ImportExcelModel.onImportFromExcel(p.searchControl);
    }

    /** A new report for THIS query — the query is filled in, so the author only picks a template. */
    async function handleCreate(): Promise<void> {
        const queryEntity = await Finder.API.fetchQueryEntity(queryKey);
        const report = ExcelReportEntity.create({ query: queryEntity });
        await Navigator.view(report);
        await reloadExcelReports();
    }

    async function handleAdminister(): Promise<void> {
        await Finder.explore(ExcelReportEntity.findOptions(token => ({
            filterOptions: [token(a => a.query.key).filter("EqualTo", queryKey)],
        })));
        await reloadExcelReports();
    }

    const label = (
        <span>
            <FontAwesomeIcon aria-hidden={true} icon="file-excel" />
            {p.searchControl.props.largeToolbarButtons === true
                ? <span className="d-none d-sm-inline">{" " + ExcelMessage.ExportToExcel.niceToString()}</span>
                : undefined}
        </span>
    );

    // With nothing to choose between, the menu IS the export button.
    if (p.plainExcel && !p.importFromExcel && !p.excelReport)
        return (
            <button className="sf-query-button sf-search btn btn-tertiary" title={ExcelMessage.ExportToExcel.niceToString()}
                onClick={() => void handlePlainExcel()}>
                {label}
            </button>
        );

    // Whoever may SAVE a report may administer
    // them, and a role that may only RUN one just gets the list. Read off the metadata blob, which is
    // where altea keeps the per-role operation list.
    const canAdminister = p.excelReport
        && getOperationInfos(ExcelReportEntity).some(oi => oi.key === ExcelReportOperation.Save.key);

    return (
        <Dropdown show={isOpen} onToggle={handleToggle} title={ExcelMessage.ExportToExcel.niceToString()}>
            <Dropdown.Toggle id="excelDropDown" variant="tertiary">
                {label}
            </Dropdown.Toggle>
            <Dropdown.Menu>
                {withDividers([
                    p.plainExcel &&
                        <Dropdown.Item key="plain" onClick={() => void handlePlainExcel()}>
                            <FontAwesomeIcon aria-hidden={true} icon="file-excel" className="me-2" />
                            {ExcelMessage.ExportToExcel.niceToString()}
                        </Dropdown.Item>,
                    p.importFromExcel &&
                        <Dropdown.Item key="import" onClick={() => void handleImportFromExcel()}>
                            <FontAwesomeIcon aria-hidden={true} icon="file-excel" className="me-2" />
                            {ImportFromExcelMessage.ImportFromExcel.niceToString()}
                        </Dropdown.Item>,
                    p.excelReport && withDividers([
                        excelReports?.map((report, i) =>
                            <Dropdown.Item key={"report" + i} onClick={() => void handleExcelReport(report)}>
                                {report.toString()}
                            </Dropdown.Item>) ?? [],
                        canAdminister ? [
                            <Dropdown.Item key="administer" onClick={() => void handleAdminister()}>
                                <FontAwesomeIcon aria-hidden={true} icon="magnifying-glass" className="me-2" />
                                {ExcelMessage.Administer.niceToString()}
                            </Dropdown.Item>,
                            <Dropdown.Item key="create" onClick={() => void handleCreate()}>
                                <FontAwesomeIcon aria-hidden={true} icon="plus" className="me-2" />
                                {ExcelMessage.CreateNew.niceToString()}
                            </Dropdown.Item>,
                        ] : [],
                    ]),
                ])}
            </Dropdown.Menu>
        </Dropdown>
    );
}

/**
 * A divider BETWEEN the sections that actually rendered something.
 *
 * Written out because the naive version (a divider before each section) puts one at the top when the first
 * section is empty, and two together when a middle one is.
 */
function withDividers(
    sections: (React.ReactElement | React.ReactElement[] | false | null | undefined)[],
): React.ReactElement[] {
    const result: React.ReactElement[] = [];

    for (const section of sections) {
        if (!section || (Array.isArray(section) && section.length === 0))
            continue;

        if (result.length > 0)
            result.push(<Dropdown.Divider key={"divider" + result.length} />);

        if (Array.isArray(section))
            result.push(...section);
        else
            result.push(section);
    }

    return result;
}

/**
 * An export writes what the REQUEST says, so a paginated search has to be asked
 * whether it means this page or all of them. Answered without a question when the current page already holds
 * every row.
 */
export async function selectPagination(sc: SearchControlLoaded): Promise<QueryRequest | undefined> {
    const request = sc.getQueryRequest(true);
    const rt = sc.state.resultTable;

    if (request.pagination.mode !== "Firsts" &&
        !(request.pagination.mode === "Paginate" && (rt == null || rt.totalElements! > rt.rows.length)))
        return request;

    const pm = await SelectorModal.chooseElement<PaginationModeKeys>([request.pagination.mode, "All"], {
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
