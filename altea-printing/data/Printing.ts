import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { IQuery } from "@altea/altea/data/iquery";
import { column, entity, fieldValidation, implementedBy, quoted, stringLengthValidator } from "@altea/altea/data/decorators";
import { registerEnum } from "@altea/altea/data/registration";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import type { ConstructSymbol, ExecuteSymbol } from "@altea/altea/data/operations";
import type { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { FilePathEmbedded, FileTypeSymbol } from "@altea/altea-files/data/Files";
import type { ProcessAlgorithmSymbol } from "@altea/altea-processes/data/Processes";
import type { SimpleTaskSymbol } from "@altea/altea-scheduler/data/Scheduler";

// Port of Signum.Printing's PrintLine.cs + PrintPackages.cs — a PRINT QUEUE. Something that produces a
// document (a report, a label, an invoice) drops a line here instead of printing it itself; a line carries
// the file and moves through states; a package is a batch a process walks, printing each line through the
// app-supplied `PrintingLogic.print` hook.
//
// altea divergences:
//  - **Signum's table-driven `StateValidator` becomes per-field `@fieldValidation`**, the same translation
//    @altea/altea-email made for EmailMessage: the same rules, expressed one field at a time, since altea
//    has no such table helper. Signum's table reads
//
//        state              printedOn  package
//        NewTest            null       null
//        ReadyToPrint       null       null
//        Enqueued           null       SET
//        Printed            SET        (either)
//        Error              null       (either)
//        Cancelled          null       (either)
//        PrintedAndDeleted  SET        (either)
//
//  - `[Ignore] TestFileType` → `@column(false)`: it is the file type the "create a test line" operation
//    hands the FileLine so it knows where to upload, never a stored value.
//  - `Referred` keeps Signum's EMPTY `@implementedBy`: what a printed document refers to is app-defined, so
//    an app widens it in its shared entity-overrides module.
//  - NO custom `toString()`, as in Signum: the default "<NiceName> <id>" applies. (A first attempt built one
//    from the state — `PrintLineState[this.state]` — which is a reverse ENUM LOOKUP, i.e. a subscript no SQL
//    dialect can evaluate; PostgreSQL answered "cannot subscript type unknown".)
@reflect
@entity("System", "Transactional")
export class PrintLineEntity extends Entity {
    creationDate: Temporal.PlainDateTime = Clock.now;

    /** Signum's `[Ignore]` — a UI-only hint for the test line's FileLine, never persisted. */
    @column(false)
    testFileType: FileTypeSymbol | null;

    file: FilePathEmbedded;

    @fieldValidation<PrintLineEntity>(p => p.state === PrintLineState.Enqueued && p.package == null
        ? "A line must belong to a package once it is Enqueued"
        : (p.state === PrintLineState.NewTest || p.state === PrintLineState.ReadyToPrint) && p.package != null
            ? "A line may not belong to a package before it is Enqueued"
            : null)
    package: Lite<PrintPackageEntity> | null;

    @fieldValidation<PrintLineEntity>(p => {
        const printed = p.state === PrintLineState.Printed || p.state === PrintLineState.PrintedAndDeleted;
        return printed && p.printedOn == null ? "A printed line must say when it was printed"
            : !printed && p.printedOn != null ? "Only a printed line may say when it was printed"
                : null;
    })
    printedOn: Temporal.PlainDateTime | null;

    @implementedBy(() => [])
    referred: Lite<Entity> | null;

    state: PrintLineState;
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

/** Signum's `PrintPackageEntity` — one batch of lines, and what the PrintPackage process runs over. */
@reflect
@entity("System", "Transactional")
export class PrintPackageEntity extends Entity {
    @stringLengthValidator({ max: 200 })
    name: string | null;

    @quoted toString(): string { return this.name ?? "- No Name -"; }

    /**
     * Signum's `PrintPackageEntity.Lines()` — the package's own lines, as a query token. An
     * `[AutoExpressionField]` extension method there; here a `withQuoted` prototype member the SERVER
     * assigns (its body is a query), which is why it is optional on this isomorphic declaration.
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

/** Signum's `PrintStat` — one "N lines of this file type are ready" row on the panel. */
export interface PrintStat {
    fileType: FileTypeSymbol;
    count: number;
}
