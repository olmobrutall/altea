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
import { ProcessLogic } from "@altea/altea-processes/server/ProcessLogic.server";
import type { ExecutingProcess } from "@altea/altea-processes/server/ProcessRunner.server";
import { ProcessEntity, ProcessOperation } from "@altea/altea-processes/data/Processes";
import { SimpleTaskLogic } from "@altea/altea-scheduler/server/SimpleTaskLogic.server";
import {
    MultipleSMSModel, SMSMessageEntity, SMSMessageOperation, SMSMessageProcess, SMSMessageState,
    SMSMessageTask, SMSSendPackageEntity, SMSUpdatePackageEntity, SMSMessage,
    type SMSOwnerData,
} from "../data/SMS";
import { SMSLogic } from "./SMSLogic.server";

// Port of Signum.SMS's SMSProcessLogic.cs + SMSProcessAlgortihms.cs — the BATCH half: the two process
// algorithms that walk a package, the scheduled task that refreshes every sent message's status, and the
// "send this text to all of these" contextual operation a host registers per owner type.
//
// altea divergences:
//  - **the two algorithms are `registerAction` closures**, not `IProcessAlgorithm` classes: altea's
//    `ProcessLogic.registerAction` is exactly Signum's `Register(symbol, Action<ExecutingProcess>)` overload,
//    and neither algorithm has state.
//  - **`ExecutingProcess.ForEachLine` → `ep.forEach(items, label, action, lineOf)`**, altea's counterpart
//    (progress + per-line exception rows), the same call altea-workflow's Timeout algorithm makes.
//  - **the two package QUERIES are plain `withQuery()`**. Signum registers a hand-written projection with
//    `NumLines` / `LastProcess` / `NumErrors` columns computed from `e.LastProcess()` and
//    `p.ExceptionLines()`; altea's process module exposes neither expression, so those three columns are the
//    part not ported — the package VIEW shows its messages in a SearchControl instead, which is where a user
//    looks anyway.
//  - **`UnsafeUpdate().Set(...)` → `executeUpdate`**, altea's set-based update.
export namespace SMSProcessLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // Signum includes the two packages explicitly. Their only fields come from the abstract base, so
        // neither has a reference that would pull the other in.
        sb.include(SMSSendPackageEntity).withQuery();
        sb.include(SMSUpdatePackageEntity).withQuery();

        // Signum's `SMSMessageSendProcessAlgortihm`: send every message of the package still Created.
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

        // Signum's `SMSMessageUpdateStatusProcessAlgorithm`: ask the gateway about every Sent message the
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

        // Signum's `SimpleTaskLogic.Register(SMSMessageTask.UpdateSMSStatus, …)`.
        SimpleTaskLogic.register(SMSMessageTask.UpdateSMSStatus, async () => {
            const process = await updateAllSentSMS();
            return process?.toLite() ?? null;
        });

        // Signum's `Graph<ProcessEntity>.ConstructFromMany<SMSMessageEntity>(CreateUpdateStatusPackage)`.
        new Graph.ConstructFromMany(SMSMessageEntity, SMSMessageOperation.CreateUpdateStatusPackage, {
            construct: async (lites: Lite<SMSMessageEntity>[]) => {
                // Signum's `messages.RetrieveList()`: ONE chunked `WHERE id IN (…)` per type, not a query
                // per lite. Same "missing row throws" semantics the per-lite `.single()` had.
                const messages = await retrieveFromListOfLite(lites);

                // ALTEA: Signum returns `null` when there is nothing to package, and the client silently
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
     * Signum's `RegisterSMSOwnerData<T>(phoneExpression)` — the "send this text to every selected one of
     * these" contextual operation, per owner type.
     *
     * ALTEA: the `Expression<Func<T, SMSOwnerData>>` becomes a plain async projector. Signum evaluates its
     * expression IN SQL (`.Select(pr => phoneExpression.Evaluate(pr))`); a `@quoted` member returning a
     * hand-built object is not something altea's provider lowers, and the selected set is a bounded list
     * anyway — so the owner data is produced in memory, from the retrieved rows.
     */
    export function registerSMSOwnerData<T extends Entity>(
        type: Type<T>,
        ownerData: (entity: T) => SMSOwnerData | Promise<SMSOwnerData>,
    ): void {
        // The symbol is declared `FromMany<Entity>` (Signum's too) and registered once per owner TYPE, so the
        // cast is what Signum's `Graph<ProcessEntity>.ConstructFromMany<T>` expresses in its generics.
        new Graph.ConstructFromMany(type, SMSMessageOperation.SendMultipleSMSMessages as never, {
            construct: async (lites: Lite<T>[], args: unknown[]) => {
                const model = args.find(a => a instanceof MultipleSMSModel) as MultipleSMSModel | undefined;
                if (model == null)
                    throw new Error("SendMultipleSMSMessages requires a MultipleSMSModel argument");
                if (model.message == null || model.message.trim() === "")
                    throw new Error(SMSMessage.TheTextForTheSMSMessageHasNotBeenSet.niceToString());

                // Signum de-duplicates the owner data (SMSOwnerData.Equals compares the OWNER), then splits
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

                // Signum returns null here; see the note on CreateUpdateStatusPackage above.
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

    /** Signum's `UpdateMessages(messages)` — package them and queue the status-update process. */
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
            // Signum resets this in the property's SETTER; altea entities are plain fields, so the two
            // writers of `updatePackage` do it (see data/SMS.ts).
            m.updatePackageProcessed = false;
            await m.save();
        }

        const process = await ProcessLogic.create(SMSMessageProcess.UpdateStatus, packLite);
        return await Operations.execute(process, ProcessOperation.Execute);
    }

    /** Signum's `UpdateAllSentSMS` — what the scheduled task runs. */
    export async function updateAllSentSMS(): Promise<ProcessEntity | null> {
        if (!await table(SMSMessageEntity).filter(m => m.state == SMSMessageState.Sent).some())
            return null;

        const pack = SMSUpdatePackageEntity.create({ name: packageName(SMSUpdatePackageEntity) });
        await pack.save();
        const packLite = pack.toLite();

        // A set-based UPDATE, as Signum's UnsafeUpdate is: the sent set can be large and none of it needs
        // the save pipeline.
        await table(SMSMessageEntity)
            .filter(m => m.state == SMSMessageState.Sent)
            .executeUpdate(() => ({ updatePackage: packLite, updatePackageProcessed: false }));

        const process = await ProcessLogic.create(SMSMessageProcess.UpdateStatus, packLite);
        return await Operations.execute(process, ProcessOperation.Execute);
    }

    /** Signum's `SMSPackageEntity()` constructor: `GetType().NiceName() + ": " + Clock.Now`. */
    function packageName(type: Type<Entity>): string {
        return `${(type as unknown as { niceName(): string }).niceName()}: ${Clock.now.toString()}`;
    }

    void SMSLogic; // the two algorithms above run through the operations SMSLogic registers
}
