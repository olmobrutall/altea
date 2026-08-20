import { reflect, init } from "@altea/altea/data/reflection";
import { EmbeddedEntity, ModelEntity } from "@altea/altea/data/entity";
import { stringLengthValidator, fieldValidation } from "@altea/altea/data/decorators";
import { ValidationMessage } from "@altea/altea/data/validators";
import { msg } from "@altea/altea/data/utils/localization";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { FileEmbedded } from "@altea/altea-files/data/Files";

// Port of Signum.Excel's ExcelImportModel.cs + the permission / message declarations of Signum.Excel.ts.
// Signum.Excel does three things; this port covers TWO of them, per the app's scope:
//
//   PLAIN EXCEL EXPORT  — any query's ResultTable straight to .xlsx (ExcelPermission.PlainExcel)
//   IMPORT FROM EXCEL   — an .xlsx back into entities through an operation (ExcelPermission.ImportFromExcel)
//
// NOT ported: ExcelReportEntity (a stored .xlsx TEMPLATE whose named columns are filled from a query) and
// ExcelAttachmentEntity (a UserQuery exported to .xlsx as an email attachment). The template-driven half of
// Signum.Excel is what @altea/altea-office-template already does — an .xlsx template with `@[Token]` tokens
// and a foreach block is strictly more capable than ExcelReport's column-name matching — so it is
// deliberately not duplicated. Consequently ExcelReportOperation, ExcelGenerator and the ExcelReport-only
// messages have no counterpart here.
//
// altea divergences:
//  - The two halves have their OWN starters (PlainExcelLogic.start / ExcelImportLogic.start) instead of
//    Signum's single `ExcelLogic.Start(sb, excelReport: bool)`: they share nothing but this file, and an app
//    that wants export without import (or the reverse) should not have to pass a flag.
//  - `ImportExcelModel` keeps Signum's shape, but its collection rows validate from the OWNER (altea has no
//    BindParent / GetParentEntity, so a row cannot reach the model it belongs to — see the note below).

// ---- permissions ---------------------------------------------------------------------------------------

export namespace ExcelPermission {
    export const PlainExcel: PermissionSymbol = init();
    export const ImportFromExcel: PermissionSymbol = init();
}

// ---- messages ------------------------------------------------------------------------------------------

/** Signum's ExcelMessage, minus the ExcelReport-only keys (Administer / ExcelReport / Reports /
 *  FindLocationFoExcelReport / ExcelTemplateMustHaveExtensionXLSXandCurrentOneHas0 /
 *  TheExcelTemplateHasAColumn0NotPresentInTheFindWindow). */
export const ExcelMessage = {
    Data: msg("Data"),
    Download: msg("Download"),
    Excel2007Spreadsheet: msg("Excel 2007 spreadsheet"),
    ThereAreNoResultsToWrite: msg("There are no results to write"),
    CreateNew: msg("Create New"),
    ExportToExcel: msg("Export to Excel"),
    WhatDoYouWantToExport: msg("What do you want to export?"),
};

/** Signum's ImportFromExcelMessage — verbatim (every key is used by the importer or its UI). */
export const ImportFromExcelMessage = {
    ImportFromExcel: msg("Import from Excel"),
    _0Errors: msg("{0} errors"),
    Importing0: msg("Importing {0}"),
    Import0FromExcel: msg("Import {0} from Excel"),
    DownloadTemplate: msg("Download template"),
    Columns0AlreadyHaveConstanValuesFromFilters: msg("Columns {0} already have constant values from filters"),
    ThisQueryHasMultipleImplementations0: msg("This query has multiple implementations {0}"),
    SomeColumnsAreIncompatibleWithImportingFromExcel: msg("Some columns are incompatible with importing from Excel"),
    Operation0IsNotSupported: msg("Operation {0} is not supported"),
    ManyFiltersTryToAssignTheSameProperty0WithDifferentValues1: msg("Many filters try to assign the same property {0} with different values {1}"),
    _0IsNotSupported: msg("{0} is not supported"),
    _01CanNotBeAssignedDirectylEachNestedFieldShouldBeAssignedIndependently: msg("{0} {1} can not be assigned directly, each nested field should be assigned independently"),
    _01CanAlsoBeUsed: msg("{0}.{1} can also be used"),
    _0IsReadOnly: msg("{0} is read only"),
    _01IsIncompatible: msg("{0} ({1}) is incompatible"),
    ErrorsIn0Rows_N: msg("Errors in {0} rows"),
    No0FoundInThisQueryWith1EqualsTo2: msg("No {0} found in this query with {1} equals to {2}"),
    UnableToAssignMoreThanOneUnrelatedCollections0: msg("Unable to assign more than one unrelated collections {0}"),
    DuplicatedNonConsecutive0Found1: msg("Duplicated non-consecutive {0} found: {1}"),
    ColumnsDoNotMatchExcelColumns0QueryColumns1: msg("Columns do not match.\nExcel columns: {0}\nQuery columns: {1}"),
};

// ---- the import model ----------------------------------------------------------------------------------

/** Signum's ImportExcelMode (ExcelImportModel.cs): what an incoming row is allowed to do. */
export enum ImportExcelMode {
    Insert,
    Update,
    InsertOrUpdate,
}

/** The string-union twin (altea's enum idiom): the member NAME is what travels on the wire. */
export type ImportExcelModeName = keyof typeof ImportExcelMode;

/**
 * Signum's CollectionElementEmbedded: one collection the import fills — the `Element` token of the
 * collection, plus the column whose value identifies an existing row of it (so an Update can match rows
 * instead of rebuilding them).
 */
@reflect
export class CollectionElementEmbedded extends EmbeddedEntity {
    collectionElement: string;

    matchByColumn: string | null;

    toString(): string {
        return this.collectionElement;
    }
}

/**
 * Signum's ImportExcelModel: everything the import needs besides the query request — the file, the entity
 * type, the operation that saves each row, and how rows map to entities.
 *
 * DIVERGENCE from Signum: the `MatchByColumn`-is-set-only-when rules of BOTH this model and its collection
 * rows are validated HERE. Signum's CollectionElementEmbedded reaches its owner through `BindParent` /
 * `GetParentEntity<ImportExcelModel>()`; altea embeddeds carry no parent pointer, and the rule for a row
 * also depends on its POSITION in the list (the last collection of an Insert needs no key), which only the
 * owner can see anyway.
 */
@reflect
export class ImportExcelModel extends ModelEntity {
    @stringLengthValidator({ max: 100 })
    typeName: string;

    excelFile: FileEmbedded;

    @stringLengthValidator({ max: 100 })
    operationKey: string;

    transactional: boolean;

    identityInsert: boolean;

    mode: ImportExcelMode;

    /** Signum's `(pi, MatchByColumn).IsSetOnlyWhen(…)` for the model's own key column. */
    @fieldValidation<ImportExcelModel>(m => isSetOnlyWhen(m.matchByColumn, needsMatchBy(m)))
    matchByColumn: string | null;

    /** Signum also puts `[NoRepeatValidator]` here. altea's NoRepeatValidator compares a `@valueField`
     *  (see validators.ts) and these rows have none, so it would be inert — the duplicate check is folded
     *  into `collectionsError` below, where it can compare what actually identifies a row. */
    @fieldValidation<ImportExcelModel>(m => collectionsError(m))
    collections: CollectionElementEmbedded[];

    toString(): string {
        return ImportFromExcelMessage.Import0FromExcel.niceToString(this.typeName);
    }
}

/** Signum's ImportExcelModel.PropertyValidation for MatchByColumn: an Update / InsertOrUpdate always needs
 *  the key, and an Insert needs it as soon as a collection has to be grouped by something. */
function needsMatchBy(m: ImportExcelModel): boolean {
    return m.mode === ImportExcelMode.Update
        || m.mode === ImportExcelMode.InsertOrUpdate
        || (m.mode === ImportExcelMode.Insert && (m.collections?.length ?? 0) > 0);
}

/**
 * Signum's CollectionElementEmbedded.PropertyValidation, evaluated per row from the owner: every collection
 * needs a key column except the LAST one of a plain Insert (its rows are simply appended). Also carries the
 * duplicate check Signum got from `[NoRepeatValidator]`.
 */
function collectionsError(m: ImportExcelModel): string | null {
    const rows = m.collections ?? [];

    const repeated = rows.map(r => r.collectionElement).filter((e, i, all) => all.indexOf(e) !== i);
    if (repeated.length > 0)
        return ValidationMessage._0HasSomeRepeatedElements1.niceToString("{0}", [...new Set(repeated)].join(", "));

    for (let i = 0; i < rows.length; i++) {
        const isLastOfInsert = m.mode === ImportExcelMode.Insert && i === rows.length - 1;
        const error = isSetOnlyWhen(rows[i].matchByColumn, !isLastOfInsert);
        if (error != null)
            return `${rows[i].collectionElement}: ${error}`;
    }
    return null;
}

/** Signum's `IsSetOnlyWhen`: mandatory when the condition holds, forbidden when it does not. */
function isSetOnlyWhen(value: string | null | undefined, condition: boolean): string | null {
    const isNull = value == null || value === "";
    if (isNull && condition)
        return ValidationMessage._0IsNotSet.niceToString("{0}");
    if (!isNull && !condition)
        return ValidationMessage._0ShouldBeNull.niceToString("{0}");
    return null;
}
