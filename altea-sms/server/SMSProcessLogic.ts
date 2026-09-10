import "@altea/altea/server";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { retrieve, retrieveFromListOfLite } from "@altea/altea/server/Database";
import { Graph } from "@altea/altea/server/graph";
import { Operations } from "@altea/altea/server/operationLogic";
import { Clock } from "@altea/altea/data/utils/clock";
import { Entity, type Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { ProcessLogic } from "@altea/altea-processes/server/ProcessLogic";
import type { ExecutingProcess } from "@altea/altea-processes/server/ProcessRunner";
import { ProcessEntity, ProcessOperation } from "@altea/altea-processes/data/Processes";
import { SimpleTaskLogic } from "@altea/altea-scheduler/server/SimpleTaskLogic";
import {
    MultipleSMSModel, SMSMessageEntity, SMSMessageOperation, SMSMessageProcess, SMSMessageState,
    SMSMessageTask, SMSSendPackageEntity, SMSUpdatePackageEntity, SMSMessage,
    type SMSOwnerData,
} from "../data/SMS";
import { SMSLogic } from "./SMSLogic";

// The BATCH half: the two process
// algorithms that walk a package, the scheduled task that refreshes every sent message's status, and the
// "send this text to all of these" contextual operation a host registers per owner type.
//
// altea divergences:
//  - **the two algorithms are `registerAction` closures**, not `IProcessAlgorithm` classes: altea's
//    `ProcessLogic.registerAction` takes the algorithm as a closure,
//    and neither algorithm has state.
//  - **`ExecutingProcess.ForEachLine` → `ep.forEach(items, label, action, lineOf)`**, altea's counterpart
//    (progress + per-line exception rows), the same call altea-workflow's Timeout algorithm makes.
//  - **the two package QUERIES are plain `withQuery()`**: the `NumLines` / `LastProcess` / `NumErrors`
//    columns Signum projects need two expressions altea's process module does not expose, so the package
//    VIEW shows its messages in a SearchControl instead — which is where a user looks anyway.
//  - **`UnsafeUpdate().Set(...)` → `executeUpdate`**, altea's set-based update.
export namespace SMSProcessLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // The two packages are included explicitly. Their only fields come from the abstract base, so
        // neither has a reference that would pull the other in.
        sb.include(SMSSendPackageEntity).withQuery();
        sb.include(SMSUpdatePackageEntity).withQuery();

        // Send every message of the package still Created.
        ProcessLogic.registerAction(SMSMessageProcess.Send, async (ep: ExecutingProcess) => {
            const pack = ep.data as Lite<SMSSendPackageEntity> | null;
            if (pack == null)
                throw new Error("The SMS Send process has no SMSSendPackageEntity");

            const messages = await table(SMSMessageEntity)
                .filter(m => m.sendPackage!.is(pack) && m.state == SMSMessageState.Created)
                .toArray() as SMSMessageEntity[];

            await ep.forEach(messages, m => m.destinationNumber,
                async m => { await Operations.execute(m, SMSMessageOperation.Send); },
                m => m.toLite());
        });

        // Ask the gateway about every Sent message the
        // package has not processed yet.
        ProcessLogic.registerAction(SMSMessageProcess.UpdateStatus, async (ep: ExecutingProcess) => {
            const pack = ep.data as Lite<SMSUpdatePackageEntity> | null;
            if (pack == null)
                throw new Error("The SMS UpdateStatus process has no SMSUpdatePackageEntity");

            const messages = await table(SMSMessageEntity)
                .filter(m => m.updatePackage!.is(pack) && m.state == SMSMessageState.Sent && m.updatePackageProcessed == false)
                .toArray() as SMSMessageEntity[];

            await ep.forEach(messages, m => m.destinationNumber,
                async m => { await Operations.execute(m, SMSMessageOperation.UpdateStatus); },
                m => m.toLite());
        });

        SimpleTaskLogic.register(SMSMessageTask.UpdateSMSStatus, async () => {
            const process = await updateAllSentSMS();
            return process?.toLite() ?? null;
        });

        new Graph.ConstructFromMany(SMSMessageEntity, SMSMessageOperation.CreateUpdateStatusPackage, {
            construct: async (lites: Lite<SMSMessageEntity>[]) => {
                // ONE chunked `WHERE id IN (…)` per type, not a query
                // per lite. Same "missing row throws" semantics the per-lite `.single()` had.
                const messages = await retrieveFromListOfLite(lites);

                // THROWS when there is nothing to package, rather than returning null and having the client
                // gets nothing back; altea's ConstructFromMany must return an entity, so the empty case
                // THROWS with what actually happened. Better feedback either way.
                const process = await updateMessages(messages);
                if (process == null)
                    throw new Error(SMSMessage.SMSMessagesMustBeSentPriorToUpdateTheStatus.niceToString());
                return process;
            },
        }).register();
    }

    /**
     * The "send this text to every selected one of
     * these" contextual operation, per owner type.
     *
     * The owner-data projector is a plain async function rather than an expression evaluated IN SQL: a
     * `@quoted` member returning a hand-built object is not something the provider lowers here, and the
     * selected set is a bounded list anyway — so the owner data is produced in memory, from the retrieved
     * rows.
     */
    export function registerSMSOwnerData<T extends Entity>(
        type: Type<T>,
        ownerData: (entity: T) => SMSOwnerData | Promise<SMSOwnerData>,
    ): void {
        // The symbol is declared `FromMany<Entity>` and registered once per owner TYPE, so the cast is what
        // the erased generic would otherwise say.
        new Graph.ConstructFromMany(type, SMSMessageOperation.SendMultipleSMSMessages as never, {
            construct: async (lites: Lite<T>[], args: unknown[]) => {
                const model = args.find(a => a instanceof MultipleSMSModel) as MultipleSMSModel | undefined;
                if (model == null)
                    throw new Error("SendMultipleSMSMessages requires a MultipleSMSModel argument");
                if (model.message == null || model.message.trim() === "")
                    throw new Error(SMSMessage.TheTextForTheSMSMessageHasNotBeenSet.niceToString());

                // De-duplicate the owner data by owner KEY (there is no value equality on an entity), then split
                // each comma-separated number into its own message.
                const seenOwners = new Set<string>();
                const targets: { telephoneNumber: string; owner: Lite<Entity> | null }[] = [];

                for (const lite of lites) {
                    // Retrieved through the LITE's own concrete type, not through `type`: the registration
                    // may be owned by an ABSTRACT base (eastwind registers CustomerEntity, whose Person /
                    // Company subclasses each have their own table), and an abstract base has no table to
                    // query. The lite already knows which one it came from.
                    const entity = await retrieve(lite.entityType as Type<Entity>, lite.id!) as T;
                    const od = await ownerData(entity);
                    if (od == null)
                        continue;

                    const ownerKey = od.owner == null ? `?${String(lite.id)}` : od.owner.key();
                    if (seenOwners.has(ownerKey))
                        continue;
                    seenOwners.add(ownerKey);

                    for (const n of (od.telephoneNumber ?? "").split(",").map(s => s.trim()).filter(s => s !== ""))
                        targets.push({ telephoneNumber: n, owner: od.owner });
                }

                // Throws rather than returning null; see the note on CreateUpdateStatusPackage above.
                if (targets.length === 0)
                    throw new Error("None of the selected rows has a telephone number to send to");

                const pack = SMSSendPackageEntity.create({ name: packageName(SMSSendPackageEntity) });
                await pack.save();
                const packLite = pack.toLite();

                for (const t of targets) {
                    await SMSMessageEntity.create({
                        destinationNumber: t.telephoneNumber,
                        sendPackage: packLite,
                        referred: t.owner,
                        message: model.message,
                        from: model.from,
                        certified: model.certified,
                        state: SMSMessageState.Created,
                    }).save();
                }

                const process = await ProcessLogic.create(SMSMessageProcess.Send, packLite);
                return await Operations.execute(process, ProcessOperation.Execute);
            },
        }).register();
    }

    /** Package them and queue the status-update process. */
    export async function updateMessages(messages: SMSMessageEntity[]): Promise<ProcessEntity | null> {
        if (messages.length === 0)
            return null;

        if (messages.some(m => m.state !== SMSMessageState.Sent))
            throw new Error(SMSMessage.SMSMessagesMustBeSentPriorToUpdateTheStatus.niceToString());

        const pack = SMSUpdatePackageEntity.create({ name: packageName(SMSUpdatePackageEntity) });
        await pack.save();
        const packLite = pack.toLite();

        for (const m of messages) {
            m.updatePackage = packLite;
            // Entities are plain fields, so this reset lives with the two
            // writers of `updatePackage` do it (see data/SMS.ts).
            m.updatePackageProcessed = false;
            await m.save();
        }

        const process = await ProcessLogic.create(SMSMessageProcess.UpdateStatus, packLite);
        return await Operations.execute(process, ProcessOperation.Execute);
    }

    /** What the scheduled task runs. */
    export async function updateAllSentSMS(): Promise<ProcessEntity | null> {
        if (!await table(SMSMessageEntity).filter(m => m.state == SMSMessageState.Sent).some())
            return null;

        const pack = SMSUpdatePackageEntity.create({ name: packageName(SMSUpdatePackageEntity) });
        await pack.save();
        const packLite = pack.toLite();

        // A set-based UPDATE: the sent set can be large and none of it needs
        // the save pipeline.
        await table(SMSMessageEntity)
            .filter(m => m.state == SMSMessageState.Sent)
            .executeUpdate(() => ({ updatePackage: packLite, updatePackageProcessed: false }));

        const process = await ProcessLogic.create(SMSMessageProcess.UpdateStatus, packLite);
        return await Operations.execute(process, ProcessOperation.Execute);
    }

    /** The package's default name: `<nice type name>: <now>`. */
    function packageName(type: Type<Entity>): string {
        return `${type.niceName()}: ${Clock.now.toString()}`;
    }

    void SMSLogic; // the two algorithms above run through the operations SMSLogic registers
}
