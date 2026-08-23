import "@altea/altea/server";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import "@altea/altea/server/operationFluentInclude";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { graph } from "@altea/altea/server/graphBuilder";
import { Operations } from "@altea/altea/server/operationLogic";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { withQuoted } from "@altea/altea/data/decorators";
import { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { IQuery } from "@altea/altea/data/iquery";
import { Clock } from "@altea/altea/data/utils/clock";
import { Temporal } from "@altea/altea/data/basics";
import { FilePathEmbedded, type FileTypeSymbol } from "@altea/altea-files/data/Files";
import { FilePathEmbeddedLogic } from "@altea/altea-files/server/FilePathEmbeddedLogic.server";
import { ProcessLogic } from "@altea/altea-processes/server/ProcessLogic.server";
import type { ExecutingProcess } from "@altea/altea-processes/server/ProcessRunner.server";
import type { ProcessEntity } from "@altea/altea-processes/data/Processes";
import { SimpleTaskLogic } from "@altea/altea-scheduler/server/SimpleTaskLogic.server";
import {
    PrintLineEntity, PrintLineOperation, PrintLineState, PrintPackageEntity, PrintPackageProcess,
    PrintPermission, PrintTask, type PrintStat,
} from "../data/Printing";

// Port of Signum.Printing's PrintLogic.cs — the print QUEUE's logic: the line's state machine, the batch
// process that walks a package, the panel's "how many are waiting" statistics, and the scheduled task that
// reclaims the files of long-printed lines.
//
// The actual PRINTING is an app seam (`PrintingLogic.print`), exactly as in Signum: what "print" means —
// a spooler, a network printer, an SDK — is not something a framework can know, and Signum's default throws.
//
// altea divergences:
//  - **`PrintPackageEntity.Lines()` is a `withQuoted` PROTOTYPE member**, assigned at the bottom of this
//    file, where Signum declares an `[AutoExpressionField]` extension method — a registered expression needs
//    a quoted member to point at. The process algorithm does not go through it (it queries the lines
//    directly), so no in-memory twin is needed.
//  - Signum's `IProcessAlgorithm` class becomes a `registerAction` closure (altea's counterpart of its
//    `Register(symbol, Action<ExecutingProcess>)` overload) — the algorithm has no state.
//  - `ExecutingProcess.ForEachLine` → `ep.forEach(items, label, action, lineOf)`.
//  - `ProcessLogic.AssertStarted` and `PermissionLogic.RegisterPermissions` have no counterparts: an app
//    calls this start after the process module's, and SymbolLogic seeds every `init()`ed symbol, so
//    DECLARING the permission in data/Printing.ts IS the registration (the note @altea/altea-map carries).
//  - `OperationLogic.AllowSave<T>()` has no counterpart: altea's save is not gated on an operation, so the
//    scopes around `line.Save()` simply disappear. (Signum's `AllowSave<PackageLineEntity>` in the cleanup
//    task is a copy-paste slip for `PrintLineEntity` anyway.)
//  - `Transaction.InTestTransaction` has no counterpart, so the print failure path always records the Error
//    state and rethrows.
export namespace PrintingLogic {

    /** Signum's `DeleteFilesAfter` — minutes a printed line's file is kept before the cleanup task drops it. */
    export let deleteFilesAfter = 24 * 60;

    /**
     * Signum's `PrintingLogic.Print` — the app's printing action. Default THROWS, as Signum's does: a queue
     * with no printer behind it should say so loudly rather than silently marking lines printed.
     */
    export let print: (line: PrintLineEntity) => void | Promise<void> =
        () => { throw new Error("PrintingLogic.print is not defined"); };

    /** Signum's `TestFileType` — where the "create a test line" operation uploads to. */
    export let testFileType: FileTypeSymbol | null = null;

    export function start(sb: SchemaBuilder, options?: { testFileType?: FileTypeSymbol }): void {
        if (sb.alreadyDefined(start))
            return;

        testFileType = options?.testFileType ?? null;

        sb.include(PrintLineEntity).withQuery();
        sb.include(PrintPackageEntity).withQuery();

        // Signum's `PrintPackageEntity.Lines()` registered expression — the package's own line list, so a
        // package's view and the process can both ask for it as a query token.
        QueryLogic.expressions.register(PrintPackageEntity, (p: PrintPackageEntity) => p.lines!(),
            { key: "Lines", niceName: () => PrintLineEntity.nicePluralName() });

        ProcessLogic.registerAction(PrintPackageProcess.PrintPackage, printPackage);
        PrintLineGraph.register();

        SimpleTaskLogic.register(PrintTask.RemoveOldFiles, removeOldFiles);
    }

    // ---- the batch process ---------------------------------------------------------------------------

    /** Signum's `PrintPackageAlgorithm` — print every line of the package that is not printed yet. */
    async function printPackage(ep: ExecutingProcess): Promise<void> {
        const pack = ep.data as Lite<PrintPackageEntity> | null;
        if (pack == null)
            throw new Error("The PrintPackage process has no PrintPackageEntity");

        const lines = await table(PrintLineEntity)
            .filter(l => l.package!.is(pack) && l.state != PrintLineState.Printed)
            .toArray() as PrintLineEntity[];

        await ep.forEach(lines, l => l.toString(), l => printLine(l), l => l.toLite());
    }

    // ---- the cleanup task ----------------------------------------------------------------------------

    /**
     * Signum's `PrintTask.RemoveOldFiles` handler: a printed line's FILE is dead weight, so drop it and mark
     * the line PrintedAndDeleted. Each line in its own transaction, and a failure is logged and skipped —
     * one unreadable file must not abandon the rest.
     */
    async function removeOldFiles(): Promise<Lite<Entity> | null> {
        const cutoff = Clock.now.add({ minutes: -deleteFilesAfter });
        const lines = await table(PrintLineEntity)
            .filter(l => l.state == PrintLineState.Printed
                && Temporal.PlainDateTime.compare(l.creationDate, cutoff) <= 0)
            .toArray() as PrintLineEntity[];

        for (const line of lines) {
            try {
                await Transaction.forceNew(async () => {
                    FilePathEmbeddedLogic.deleteFileOnCommit(line.file);
                    line.state = PrintLineState.PrintedAndDeleted;
                    await line.save();
                });
            } catch (e) {
                await ExceptionLogic.logException(e);
            }
        }

        return null;
    }

    // ---- what a document producer calls --------------------------------------------------------------

    /** Signum's `CreateLine(referred, fileType, fileName, content)`. */
    export async function createLineFromContent(
        referred: Entity, fileType: FileTypeSymbol, fileName: string, content: Uint8Array,
    ): Promise<PrintLineEntity> {
        return await createLine(referred, FilePathEmbedded.create({ fileType, fileName, binaryFile: content }));
    }

    /** Signum's `CreateLine(referred, file)` — queue one document for printing. */
    export async function createLine(referred: Entity, file: FilePathEmbedded): Promise<PrintLineEntity> {
        return await PrintLineEntity.create({
            referred: referred.toLite(),
            state: PrintLineState.ReadyToPrint,
            file,
        }).save();
    }

    /**
     * Signum's `SavePrintLine(file, entity, fileTypeForPrinting)` — replace whatever this entity already had
     * waiting for that printer with this document. The cancel-then-create order is Signum's, and it is what
     * keeps a re-generated report from printing twice.
     */
    export async function savePrintLine(
        file: { fileName: string; bytes: Uint8Array }, entity: Entity, fileTypeForPrinting: FileTypeSymbol,
    ): Promise<typeof file> {
        await cancelPrinting(entity, fileTypeForPrinting);
        await createLineFromContent(entity, fileTypeForPrinting, baseName(file.fileName), file.bytes);
        return file;
    }

    /** Signum's `CancelPrinting(entity, fileType)`. */
    export async function cancelPrinting(entity: Entity, fileType: FileTypeSymbol): Promise<void> {
        const lines = await readyToPrint(entity, fileType);
        for (const line of lines) {
            line.state = PrintLineState.Cancelled;
            FilePathEmbeddedLogic.deleteFileOnCommit(line.file);
            await line.save();
        }
    }

    /** Signum's `ReadyToPrint(entity, fileType)`. */
    export async function readyToPrint(entity: Entity, fileType: FileTypeSymbol): Promise<PrintLineEntity[]> {
        const lite = entity.toLite();
        return await table(PrintLineEntity)
            .filter(l => l.referred!.is(lite) && l.file.fileType.is(fileType) && l.state == PrintLineState.ReadyToPrint)
            .toArray() as PrintLineEntity[];
    }

    // ---- the panel -----------------------------------------------------------------------------------

    /** Signum's `GetReadyToPrintStats` — how many lines wait per file type. */
    export async function getReadyToPrintStats(): Promise<PrintStat[]> {
        const rows = await table(PrintLineEntity)
            .filter(l => l.state == PrintLineState.ReadyToPrint)
            .groupBy(l => l.file.fileType)
            .map(g => ({ fileType: g.key, count: g.elements.length }))
            .toArray();

        return rows.map(r => ({ fileType: r.fileType as FileTypeSymbol, count: Number(r.count) }));
    }

    /**
     * Signum's `CreateProcess(fileType?)` — package everything that is ready (optionally of one file type)
     * and queue the process that prints it. Null when there is nothing to print.
     */
    export async function createProcess(fileType?: FileTypeSymbol | null): Promise<ProcessEntity | null> {
        return await Transaction.forceNew(async () => {
            const ft = fileType ?? null;
            const ready = () => ft == null
                ? table(PrintLineEntity).filter(l => l.state == PrintLineState.ReadyToPrint)
                : table(PrintLineEntity).filter(l => l.state == PrintLineState.ReadyToPrint && l.file.fileType.is(ft));

            const count = await ready().count();
            if (count === 0)
                return null;

            const pack = await PrintPackageEntity.create({
                name: `${ft?.toString() ?? ""} (${count})`,
            }).save();
            const packLite = pack.toLite();

            // A set-based UPDATE, as Signum's UnsafeUpdate is: the ready set can be large and none of it
            // needs the save pipeline.
            await ready().executeUpdate(() => ({ package: packLite, state: PrintLineState.Enqueued }));

            return await ProcessLogic.create(PrintPackageProcess.PrintPackage, packLite);
        });
    }

    function baseName(fileName: string): string {
        const i = Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\"));
        return i < 0 ? fileName : fileName.slice(i + 1);
    }
}

// ---- the state machine -------------------------------------------------------------------------------

/**
 * Signum's `PrintLineGraph`. A DECLARED const registered from `start`, the altea convention.
 *
 * `Print` is the one operation with a body worth reading: it delegates to the app's `print`, and on failure
 * records the Error state in its OWN transaction before rethrowing — so the line does not roll back to
 * ReadyToPrint and get retried forever by the same process.
 */
export const PrintLineGraph = graph(PrintLineEntity, PrintLineState, g => {
    g.GetState = l => l.state;

    g.Construct(PrintLineOperation.CreateTest, {
        toStates: [PrintLineState.NewTest],
        construct: async () => PrintLineEntity.create({
            state: PrintLineState.NewTest,
            testFileType: PrintingLogic.testFileType,
        }),
    });

    g.Execute(PrintLineOperation.SaveTest, {
        canBeNew: true,
        canBeModified: true,
        fromStates: [PrintLineState.NewTest],
        toStates: [PrintLineState.ReadyToPrint],
        execute: e => { e.state = PrintLineState.ReadyToPrint; },
    });

    g.Execute(PrintLineOperation.Print, {
        fromStates: [PrintLineState.ReadyToPrint],
        toStates: [PrintLineState.Printed, PrintLineState.Error],
        execute: async e => { await printLine(e); },
    });

    g.Execute(PrintLineOperation.Retry, {
        fromStates: [PrintLineState.Error, PrintLineState.Cancelled],
        toStates: [PrintLineState.ReadyToPrint],
        execute: e => {
            e.state = PrintLineState.ReadyToPrint;
            e.package = null;
        },
    });

    g.Execute(PrintLineOperation.Cancel, {
        fromStates: [PrintLineState.ReadyToPrint, PrintLineState.Error],
        toStates: [PrintLineState.Cancelled],
        execute: e => {
            e.state = PrintLineState.Cancelled;
            e.package = null;
            e.printedOn = null;
            FilePathEmbeddedLogic.deleteFileOnCommit(e.file);
        },
    });
});

/** Signum's `PrintLineGraph.Print(line)` — also called directly by the batch process. */
async function printLine(line: PrintLineEntity): Promise<void> {
    try {
        await PrintingLogic.print(line);

        line.state = PrintLineState.Printed;
        line.printedOn = Clock.now;
        await line.save();
    } catch (error) {
        await ExceptionLogic.logException(error);

        // In its OWN transaction, so the Error state survives the caller's rollback (Signum's
        // Transaction.ForceNew for exactly this). A failure HERE is swallowed: the original error is what
        // the caller must see.
        try {
            await Transaction.forceNew(async () => {
                line.state = PrintLineState.Error;
                await line.save();
            });
        } catch { /* nothing more can be done for this line */ }

        throw error;
    }
}


// Signum's `PrintPackageEntity.Lines()` — an `[AutoExpressionField]` extension method in its logic layer.
// altea's counterpart is a `withQuoted` PROTOTYPE member (the idiom @altea/altea-view-log uses for the same
// shape), declared as an optional method on the entity and assigned here: a registered expression needs a
// quoted member to point at, and the member is server-only because its body is a query.
PrintPackageEntity.prototype.lines = withQuoted(function (this: PrintPackageEntity): IQuery<PrintLineEntity> {
    return table(PrintLineEntity).filter(l => l.package!.is(this));
});
