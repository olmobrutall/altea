import "@altea/altea/server";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import { type FluentStateMachine } from "@altea/altea/server/fluentOperations";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
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
import { FilePathEmbeddedLogic } from "@altea/altea-files/server/FilePathEmbeddedLogic";
import { ProcessLogic } from "@altea/altea-processes/server/ProcessLogic";
import type { ExecutingProcess } from "@altea/altea-processes/server/ProcessRunner";
import type { ProcessEntity } from "@altea/altea-processes/data/Processes";
import { SimpleTaskLogic } from "@altea/altea-scheduler/server/SimpleTaskLogic";
import {
    PrintLineEntity, PrintLineOperation, PrintLineState, PrintPackageEntity, PrintPackageProcess,
    PrintPermission, PrintTask, type PrintStat,
} from "../data/Printing";
import { PermissionLogic } from "@altea/altea-auth/server/PermissionLogic";

// The print QUEUE's logic: the line's state machine, the batch process that walks a package, the panel's
// "how many are waiting" statistics, and the scheduled task that reclaims the files of long-printed lines.
//
// The actual PRINTING is an app seam (`PrintingLogic.print`) whose default THROWS: what "print" means — a
// spooler, a network printer, an SDK — is not something a framework can know.
//
// Port of Signum.Printing's PrintLogic.cs — see docs/port/Printing.md.
export namespace PrintingLogic {

    /** Minutes a printed line's file is kept before the cleanup task drops it. */
    export let deleteFilesAfter = 24 * 60;

    /**
     * The app's printing action. Default THROWS: a queue with no printer behind it should say so loudly
     * rather than silently marking lines printed.
     */
    export let print: (line: PrintLineEntity) => void | Promise<void> =
        () => { throw new Error("PrintingLogic.print is not defined"); };

    /** Where the "create a test line" operation uploads to. */
    export let testFileType: FileTypeSymbol | null = null;

    export function start(sb: SchemaBuilder, options?: { testFileType?: FileTypeSymbol }): void {
        if (sb.alreadyDefined(start))
            return;

        // This permission is why PermissionLogic is a REGISTRY rather than "every declared permission": an
        // app may never start the printing module, so its database has no such row, while the SYMBOL is
        // declared the moment anything imports this module's data layer.
        PermissionLogic.registerPermissions(PrintPermission.ViewPrintPanel);

        testFileType = options?.testFileType ?? null;

        sb.include(PrintLineEntity)
            .withStateMachine(l => l.state, registerPrintLineOperations)
            .withQuery();
        sb.include(PrintPackageEntity).withQuery();

        // The package's own line list, so a package's view and the process can both ask for it as a query
        // token.
        QueryLogic.expressions.register(PrintPackageEntity, (p: PrintPackageEntity) => p.lines!(),
            { key: "Lines", niceName: () => PrintLineEntity.nicePluralName() });

        ProcessLogic.registerAction(PrintPackageProcess.PrintPackage, printPackage);

        SimpleTaskLogic.register(PrintTask.RemoveOldFiles, removeOldFiles);
    }

    // ---- the batch process ---------------------------------------------------------------------------

    /** Print every line of the package that is not printed yet. */
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
     * A printed line's FILE is dead weight, so drop it and mark the line PrintedAndDeleted. Each line in
     * its own transaction, and a failure is logged and skipped — one unreadable file must not abandon the
     * rest.
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

    /** Queue one document for printing, from its bytes. */
    export async function createLineFromContent(
        referred: Entity, fileType: FileTypeSymbol, fileName: string, content: Uint8Array,
    ): Promise<PrintLineEntity> {
        return await createLine(referred, FilePathEmbedded.create({ fileType, fileName, binaryFile: content }));
    }

    /** Queue one document for printing. */
    export async function createLine(referred: Entity, file: FilePathEmbedded): Promise<PrintLineEntity> {
        return await PrintLineEntity.create({
            referred: referred.toLite(),
            state: PrintLineState.ReadyToPrint,
            file,
        }).save();
    }

    /**
     * Replace whatever this entity already had waiting for that printer with this document. The
     * cancel-then-create ORDER is what keeps a re-generated report from printing twice.
     */
    export async function savePrintLine(
        file: { fileName: string; bytes: Uint8Array }, entity: Entity, fileTypeForPrinting: FileTypeSymbol,
    ): Promise<typeof file> {
        await cancelPrinting(entity, fileTypeForPrinting);
        await createLineFromContent(entity, fileTypeForPrinting, baseName(file.fileName), file.bytes);
        return file;
    }

    /** Cancel whatever this entity has waiting for that printer. */
    export async function cancelPrinting(entity: Entity, fileType: FileTypeSymbol): Promise<void> {
        const lines = await readyToPrint(entity, fileType);
        for (const line of lines) {
            line.state = PrintLineState.Cancelled;
            FilePathEmbeddedLogic.deleteFileOnCommit(line.file);
            await line.save();
        }
    }

    /** Is a document of that type already queued for this entity? */
    export async function readyToPrint(entity: Entity, fileType: FileTypeSymbol): Promise<PrintLineEntity[]> {
        const lite = entity.toLite();
        return await table(PrintLineEntity)
            .filter(l => l.referred!.is(lite) && l.file.fileType.is(fileType) && l.state == PrintLineState.ReadyToPrint)
            .toArray() as PrintLineEntity[];
    }

    // ---- the panel -----------------------------------------------------------------------------------

    /** How many lines wait per file type. */
    export async function getReadyToPrintStats(): Promise<PrintStat[]> {
        const rows = await table(PrintLineEntity)
            .filter(l => l.state == PrintLineState.ReadyToPrint)
            .groupBy(l => l.file.fileType)
            .map(g => ({ fileType: g.key, count: g.elements.length }))
            .toArray();

        return rows.map(r => ({ fileType: r.fileType as FileTypeSymbol, count: Number(r.count) }));
    }

    /**
     * Package everything that is ready (optionally of one file type) and queue the process that prints it.
     * Null when there is nothing to print.
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

            // A set-based UPDATE: the ready set can be large and none of it needs the save pipeline.
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
 * A named function the include's `withStateMachine` calls, which is how a whole graph stays out of `start`
 * (see @altea/altea/server/fluentOperations).
 *
 * `Print` is the one operation with a body worth reading: it delegates to the app's `print`, and on failure
 * records the Error state in its OWN transaction before rethrowing — so the line does not roll back to
 * ReadyToPrint and get retried forever by the same process.
 */
function registerPrintLineOperations(sm: FluentStateMachine<PrintLineEntity, PrintLineState>): void {
    sm.withConstruct(PrintLineOperation.CreateTest, {
        toStates: [PrintLineState.NewTest],
        construct: async () => PrintLineEntity.create({
            state: PrintLineState.NewTest,
            testFileType: PrintingLogic.testFileType,
        }),
    });

    sm.withExecute(PrintLineOperation.SaveTest, {
        canBeNew: true,
        canBeModified: true,
        fromStates: [PrintLineState.NewTest],
        toStates: [PrintLineState.ReadyToPrint],
        execute: e => { e.state = PrintLineState.ReadyToPrint; },
    });

    sm.withExecute(PrintLineOperation.Print, {
        fromStates: [PrintLineState.ReadyToPrint],
        toStates: [PrintLineState.Printed, PrintLineState.Error],
        execute: async e => { await printLine(e); },
    });

    sm.withExecute(PrintLineOperation.Retry, {
        fromStates: [PrintLineState.Error, PrintLineState.Cancelled],
        toStates: [PrintLineState.ReadyToPrint],
        execute: e => {
            e.state = PrintLineState.ReadyToPrint;
            e.package = null;
        },
    });

    sm.withExecute(PrintLineOperation.Cancel, {
        fromStates: [PrintLineState.ReadyToPrint, PrintLineState.Error],
        toStates: [PrintLineState.Cancelled],
        execute: e => {
            e.state = PrintLineState.Cancelled;
            e.package = null;
            e.printedOn = null;
            FilePathEmbeddedLogic.deleteFileOnCommit(e.file);
        },
    });
}

/** Also called directly by the batch process. */
async function printLine(line: PrintLineEntity): Promise<void> {
    try {
        await PrintingLogic.print(line);

        line.state = PrintLineState.Printed;
        line.printedOn = Clock.now;
        await line.save();
    } catch (error) {
        await ExceptionLogic.logException(error);

        // In its OWN transaction, so the Error state survives the caller's rollback. A failure HERE is
        // swallowed: the original error is what the caller must see.
        try {
            await Transaction.forceNew(async () => {
                line.state = PrintLineState.Error;
                await line.save();
            });
        } catch { /* nothing more can be done for this line */ }

        throw error;
    }
}

// `PrintPackageEntity.lines()` is a `withQuoted` PROTOTYPE member (the idiom @altea/altea-view-log uses for
// the same shape), declared as an optional method on the entity and assigned here: a registered expression
// needs a quoted member to point at, and the member is server-only because its body is a query.
PrintPackageEntity.prototype.lines = withQuoted(function (this: PrintPackageEntity): IQuery<PrintLineEntity> {
    return table(PrintLineEntity).filter(l => l.package!.is(this));
});
