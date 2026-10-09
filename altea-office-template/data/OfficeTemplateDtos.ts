import type { BaseEntity, Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { HttpError } from "@altea/altea/data/exception";
import type { QueryRequest } from "@altea/altea/data/dynamicQuery/queryRequest";
import type { OfficeTemplateEntity } from "./OfficeTemplate";
import type { ImportExcelModel } from "./Excel";
import type { ExcelReportEntity } from "./excel/ExcelReport";

export interface CreateOfficeReportRequest {
    template: Lite<OfficeTemplateEntity>;
    lite?: Lite<Entity> | null;
    /** An entity, or the model a template's OfficeModel is built from. */
    entity?: BaseEntity | null;
}

export interface GetOfficeTemplatesRequest {
    lite: Lite<Entity> | null;
}

/** The report to run, and the search that feeds it. */
export interface ExcelReportRequest {
    queryRequest: QueryRequest;
    excelReport: Lite<ExcelReportEntity>;
}

export interface ImportFromExcelRequest {
    importModel: ImportExcelModel;
    queryRequest: QueryRequest;
}

export type ImportActionKeys = "Inserted" | "Updated" | "NoChanges";

/** One row's outcome, streamed as one NDJSON line as it happens. */
export interface ImportResult {
    totalRows: number;
    action: ImportActionKeys;
    rowIndex: number;
    entity?: Lite<Entity> | null;
    error?: string | null;
}

/**
 * The last line of a stream that failed after it had already started: the `HttpError` the exception filter
 * would have written as a body, so the client raises it as the `ServiceError` every other failed call
 * produces. Distinguishable from an ImportResult by the single member.
 */
export interface ImportErrorLine {
    importError: HttpError;
}
