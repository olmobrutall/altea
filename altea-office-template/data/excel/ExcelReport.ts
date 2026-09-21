import { init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, legacyTableName, quoted } from "@altea/altea/data/decorators";
import { stringLengthValidator, validate } from "@altea/altea/data/validators";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { FileEmbedded } from "@altea/altea-files/data/Files";
import { ExcelMessage } from "../Excel";
import type { DeleteSymbol, ExecuteSymbol } from "@altea/altea/data/operations";

// Port of Signum.Excel's ExcelReportEntity.cs — see port/OfficeTemplate.md.
//
// A stored .xlsx TEMPLATE attached to a query.
//
// What it is, and why it exists beside @altea/altea-office-template's own xlsx templating: an ExcelReport
// is a whole WORKBOOK the author built in Excel — pivot tables, charts, extra sheets whose formulas point
// at the data — of which exactly one sheet, named "Data", is a sample table. Running the report REFILLS
// that sheet from a query and repoints every pivot cache at the new range; the rest of the workbook is
// untouched and recalculates on open. The template carries no tokens at all: a column is matched by its
// DISPLAY NAME against the query's columns, and each column's formatting is taken from the sample row.
//
// That is a different job from an OfficeTemplate, which fills `@[Token]` placeholders and expands a
// foreach block. This package's header used to say the report half was "strictly less capable and
// deliberately not duplicated"; that was the wrong conclusion from a true premise. A token template IS
// more capable at composing a document, and is no substitute for handing an analyst a workbook whose
// pivots and charts they already built and only the numbers change — nor for READING the ExcelReport rows
// a Signum database already has, which is what makes an application migrate rather than restart.
//
// altea divergences:
//  - the table lives in the `excel` schema, which is why this file is its own directory: the
//    schema scope is per PACKAGE + DIRECTORY and `data/OfficeTemplate.ts` already claims `data/` for
//    `word`. A `setDefaultDatabaseSchema("excel")` beside it would REPLACE that scope, not add to it.
//  - `[AutoExpressionField] ToString() => DisplayName` is a `@quoted` override, altea's same mechanism.

@entity("Main", "Master")
export class ExcelReportEntity extends Entity {
    query: QueryEntity;

    @stringLengthValidator({ min: 3, max: 200 })
    displayName: string;

    // NEW here: Signum asserts the extension when the report RUNS, which means a
    // template saved with the wrong extension looks fine until someone tries to use it. The same rule as
    // a validation refuses it at save time; the run-time assert is kept too, for a row that predates this.
    @validate<ExcelReportEntity>(r => extensionError(r.file))
    file: FileEmbedded;

    @quoted
    override toString(): string {
        return this.displayName;
    }
}

export namespace ExcelReportOperation {
    export const Save: ExecuteSymbol<ExcelReportEntity> = init();
    export const Delete: DeleteSymbol<ExcelReportEntity> = init();
}

/** The extension rule, shared by the validation above and ExcelReportLogic's run-time assert. */
export function extensionError(file: FileEmbedded | null | undefined): string | undefined {
    const fileName = file?.fileName;
    if (fileName == null || fileName === "")
        return undefined; // the NotNull validator says that

    const dot = fileName.lastIndexOf(".");
    const extension = dot < 0 ? "" : fileName.substring(dot);
    return extension.toLowerCase() === ".xlsx" ? undefined
        : ExcelMessage.ExcelTemplateMustHaveExtensionXLSXandCurrentOneHas0.niceToString(extension);
}

setDefaultDatabaseSchema("excel");
