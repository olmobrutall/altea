import { init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { IQuery } from "@altea/altea/data/iquery";
import { column, entity, implementedBy, quoted } from "@altea/altea/data/decorators";
import { validate, stringLengthValidator, ValidationMessage } from "@altea/altea/data/validators";
import { Enum } from "@altea/altea/data/enum";
import { registerEnum } from "@altea/altea/data/registration";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import type { ConstructSymbol, ExecuteSymbol } from "@altea/altea/data/operations";
import type { PermissionSymbol } from "@altea/altea/data/permissionSymbol";
import { FilePathEmbedded, FileTypeSymbol } from "@altea/altea-files/data/Files";
import type { ProcessAlgorithmSymbol } from "@altea/altea-processes/data/Processes";
import type { SimpleTaskSymbol } from "@altea/altea-scheduler/data/Scheduler";

// A PRINT QUEUE. Something that produces a document (a report, a label, an invoice) drops a line here
// instead of printing it itself; a line carries the file and moves through states; a package is a batch a
// process walks, printing each line through the app-supplied `PrintingLogic.print` hook.
//
// NO custom `toString()`: the default "<NiceName> <id>" applies. A first attempt built one from the state —
// `PrintLineState[this.state]` — which is a reverse ENUM LOOKUP, i.e. a subscript no SQL dialect can
// evaluate; PostgreSQL answered "cannot subscript type unknown" on every query of the table.
//
// Port of Signum.Printing's PrintLine.cs + PrintPackages.cs — see port/Printing.md.
@entity("System", "Transactional")
export class PrintLineEntity extends Entity {
    creationDate: Temporal.PlainDateTime = Clock.now;

    /** A UI-only hint for the test line's FileLine, never persisted. */
    @column(false)
    testFileType: FileTypeSymbol | null;

    file: FilePathEmbedded;

    // The two columns of Signum's `StateValidator<PrintLineEntity, PrintLineState>` (PrintLine.cs),
    // wearing the sentences that validator produces: `_0IsNecessaryOnState1` when the state demands a
    // value that is absent, `_0IsNotAllowedOnState1` when it forbids one that is there. Both used to be
    // raw English, which is the one thing a user-visible string may not be.
    @validate<PrintLineEntity>((p, fi) => p.state === PrintLineState.Enqueued && p.package == null
        ? ValidationMessage._0IsNecessaryOnState1.niceToString(fi.niceToString(), niceState(p.state))
        : (p.state === PrintLineState.NewTest || p.state === PrintLineState.ReadyToPrint) && p.package != null
            ? ValidationMessage._0IsNotAllowedOnState1.niceToString(fi.niceToString(), niceState(p.state))
            : null)
    package: Lite<PrintPackageEntity> | null;

    @validate<PrintLineEntity>((p, fi) => {
        const printed = p.state === PrintLineState.Printed || p.state === PrintLineState.PrintedAndDeleted;
        return printed && p.printedOn == null
            ? ValidationMessage._0IsNecessaryOnState1.niceToString(fi.niceToString(), niceState(p.state))
            : !printed && p.printedOn != null
                ? ValidationMessage._0IsNotAllowedOnState1.niceToString(fi.niceToString(), niceState(p.state))
                : null;
    })
    printedOn: Temporal.PlainDateTime | null;

    @implementedBy(() => [])
    referred: Lite<Entity> | null;

    state: PrintLineState;
}

/** The state as the user sees it — a state field holds the numeric ordinal in memory. */
function niceState(state: PrintLineState): string {
    return Enum.niceName(PrintLineState, Enum.toName(PrintLineState, state)!);
}

export enum PrintLineState {
    NewTest,
    ReadyToPrint,
    Enqueued,
    Printed,
    Cancelled,
    Error,
    PrintedAndDeleted,
}
registerEnum(PrintLineState);

export namespace PrintLineOperation {
    export const CreateTest: ConstructSymbol<PrintLineEntity> = init();
    export const SaveTest: ExecuteSymbol<PrintLineEntity> = init();
    export const Print: ExecuteSymbol<PrintLineEntity> = init();
    export const Retry: ExecuteSymbol<PrintLineEntity> = init();
    export const Cancel: ExecuteSymbol<PrintLineEntity> = init();
}

/** One batch of lines, and what the PrintPackage process runs over. */
@entity("System", "Transactional")
export class PrintPackageEntity extends Entity {
    @stringLengthValidator({ max: 200 })
    name: string | null;

    @quoted toString(): string { return this.name ?? "- No Name -"; }

    /**
     * The package's own lines, as a query token. A `withQuoted` prototype member the SERVER assigns (its
     * body is a query), which is why it is optional on this isomorphic declaration.
     */
    lines?(): IQuery<PrintLineEntity>;
}

export namespace PrintPackageProcess {
    export const PrintPackage: ProcessAlgorithmSymbol = init();
}

export namespace PrintPermission {
    export const ViewPrintPanel: PermissionSymbol = init();
}

export namespace PrintTask {
    export const RemoveOldFiles: SimpleTaskSymbol = init();
}

/** One "N lines of this file type are ready" row on the panel. */
export interface PrintStat {
    fileType: FileTypeSymbol;
    count: number;
}

setDefaultDatabaseSchema("printing");
