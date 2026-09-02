import { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";

import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { retrieveFromListOfLite } from "@altea/altea/server/Database";
import type { SchemaBuilder } from "@altea/altea/server/schema/schemaBuilder";
import { SchedulerLogic } from "@altea/altea-scheduler/server/SchedulerLogic.server";
import { toQueryRequest } from "@altea/altea-user-queries/server/UserQueryRequest.server";
import { UserQueryEntity } from "@altea/altea-user-queries/data/UserQuery";
import { TemplatingLogic } from "@altea/altea-templating/server/TemplatingLogic.server";
import { Operations } from "@altea/altea/server/operationLogic";
import { ProcessOperation } from "@altea/altea-processes/data/Processes";
import { EmailMessageEntity } from "../data/EmailMessage";
import { SendEmailTaskEntity, SendEmailTaskOperation, EmailTemplateTargetFrom } from "../data/SendEmailTask";
import { EmailLogic } from "./EmailLogic.server";
import { EmailTemplateLogic } from "./EmailTemplateLogic.server";
import { EmailPackageLogic } from "./EmailPackageLogic.server";

// Port of Signum.Mailing/Package/SendEmailTaskLogic.cs — the scheduled task that sends one template, to
// nothing / to one target / to every row a user query returns.
//
// altea divergences:
//  - `SchedulerLogic.ExecuteTask.Register` → `SchedulerLogic.registerExecuteTask`, altea's same registry.
//  - Signum's THREE static property validations (target-from vs the template's query, and whether the
//    chosen target's type is among the query's implementations) are NOT ported. Each reads
//    `QueryLogic.Queries.QueryDescription(queryName).Columns.Single(a => a.IsEntity).Implementations`, and
//    altea has no QueryDescription — its token trees are built client-side from the reflection metadata,
//    so there is no server-side "the implementations of this query's entity column" to check against. The
//    two checks that need no query — a unique target only when TargetFrom is Unique, a user query only
//    when it is UserQuery — ARE ported, as `@fieldValidation` on the entity.
//  - `RetrieveAndRemember` → an ordinary retrieve (altea has no ambient EntityCache).
//  - the grouping branch reads the first column and requires it to be a Lite, exactly as Signum does.

export namespace SendEmailTaskLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(SendEmailTaskEntity)
            .withQuery()
            .withSave(SendEmailTaskOperation.Save, {});

        SchedulerLogic.registerExecuteTask(SendEmailTaskEntity, async task => {
            switch (task.targetFrom) {
                case EmailTemplateTargetFrom.NoTarget:
                    return await sendAll(await EmailTemplateLogic.createEmailMessageFromLite(task.emailTemplate));

                case EmailTemplateTargetFrom.Unique: {
                    if (task.uniqueTarget == null)
                        throw new Error(`${task.name}: TargetFrom is Unique but no UniqueTarget is set`);

                    let target = (await retrieveFromListOfLite([task.uniqueTarget]))[0];
                    if (task.modelConverter != null)
                        target = TemplatingLogic.convert(task.modelConverter, target);

                    return await sendAll(await EmailTemplateLogic.createEmailMessageFromLite(task.emailTemplate, target));
                }

                case EmailTemplateTargetFrom.UserQuery: {
                    if (task.targetsFromUserQuery == null)
                        throw new Error(`${task.name}: TargetFrom is UserQuery but no TargetsFromUserQuery is set`);

                    const entities = await targetsOf(task.targetsFromUserQuery);
                    if (entities.length === 0)
                        return null;

                    // One process for the whole batch — this is what sendMultipleEmailsAsync exists for.
                    const process = await EmailPackageLogic.sendMultipleEmailsAsync(
                        task.emailTemplate, entities, task.modelConverter);
                    await Operations.execute(process, ProcessOperation.Execute);
                    return process.toLite();
                }

                default:
                    throw new Error(`Unexpected TargetFrom '${task.targetFrom}'`);
            }
        });
    }

    /** Signum's inline loop: queue each rendered message and answer the LAST one, which is what the
     *  scheduled-task log links to. */
    async function sendAll(emails: EmailMessageEntity[]): Promise<Lite<EmailMessageEntity> | null> {
        let last: Lite<EmailMessageEntity> | null = null;
        for (const email of emails) {
            await EmailLogic.sendMailAsync(email);
            last = email.toLite();
        }
        return last;
    }

    /** Signum's UserQuery branch: the distinct entities the user query returns. A GROUPING query has no
     *  Entity column, so its FIRST column must be the lite — Signum's same requirement and message. */
    async function targetsOf(userQuery: Lite<UserQueryEntity>): Promise<Lite<Entity>[]> {
        const request = toQueryRequest((await retrieveFromListOfLite([userQuery]))[0]);

        if (!request.groupResults) {
            // Signum clears the columns: only the entity is wanted, and a column may be expensive.
            request.columns = [];
            const result = await QueryLogic.queries.executeQueryAsync(request);
            return distinct(result.rows.map(r => r.entity as Lite<Entity> | undefined).filter((e): e is Lite<Entity> => e != null));
        }

        const result = await QueryLogic.queries.executeQueryAsync(request);
        const col = result.columns[0];
        if (col == null || !col.token.type.lite)
            throw new Error("Grouping UserQueries should have the target entity as first column");

        return distinct(result.rows
            .map(r => r.value(0) as Lite<Entity> | null)
            .filter((e): e is Lite<Entity> => e != null));
    }

    function distinct(lites: Lite<Entity>[]): Lite<Entity>[] {
        const seen = new Set<string>();
        return lites.filter(l => {
            const key = l.key();
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
    }
}
