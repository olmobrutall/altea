import "@altea/altea/server";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import { type FluentStateMachine } from "@altea/altea/server/fluentOperations";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { UserHolder } from "@altea/altea/server/userHolder";
import { withQuoted } from "@altea/altea/data/decorators";
import { Entity, type Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { IQuery } from "@altea/altea/data/iquery";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { QueryAuthLogic } from "@altea/altea-auth/server/QueryAuthLogic";
import { TypeConditionLogic } from "@altea/altea-auth/server/TypeConditionLogic";
import type { TypeConditionSymbol } from "@altea/altea-auth/data/Rules";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import {
    WhatsNewEntity, WhatsNewLogEntity, WhatsNewLogOperation, WhatsNewMessage, WhatsNewMessageEntity,
    WhatsNewOperation, WhatsNewState,
} from "../data/WhatsNew";

// In-app release notes: the state machine (Draft → Publish), "which news may this user see", and the
// per-culture message pick.
//
// **The news are NOT cached**, and that is what makes them safe: querying the table gets the ROW FILTER
// for free, applied by the LINQ binder exactly as for any other query, where a cached list would have to
// re-apply row security in memory — which altea has no twin of. The table is tiny by nature: one row per
// release.
//
// Port of Signum.WhatsNew's WhatsNewLogic.cs — see port/WhatsNew.md.
export namespace WhatsNewLogic {

    /**
     * The culture every news item must carry a message for. An app with a different primary language sets
     * it in its starter.
     */
    export let defaultCulture = "en";

    // Per `Related` type, "may the current user reach this?". A news
    // item about a query nobody may run is a news item nobody should be shown.
    const relatedConfigs = new Map<Function, (lite: Lite<Entity>) => Promise<boolean>>();

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(WhatsNewEntity)
            .withStateMachine(wn => wn.status, registerWhatsNewOperations)
            .withQuery();

        sb.include(WhatsNewLogEntity)
            .withDelete(WhatsNewLogOperation.Delete)
            .withQuery();

        QueryLogic.expressions.register(WhatsNewEntity, (wn: WhatsNewEntity) => wn.whatsNewLogs!(),
            { key: "WhatsNewLogs", niceName: () => WhatsNewLogEntity.nicePluralName() });
        QueryLogic.expressions.register(WhatsNewEntity, (wn: WhatsNewEntity) => wn.isRead!(),
            { key: "IsRead", niceName: () => WhatsNewMessage.IsRead.niceToString() });

        // A news item
        // with no message in the default culture is unreadable for most of its audience. Pushed onto the
        // route's FieldInfo, which is altea's counterpart of a static property validation added from
        // outside the declaring class (the call @altea/altea-isolation makes for its required field).
        const messagesField = PropertyRoute.root(WhatsNewEntity).addMember("messages").fieldInfo!;
        messagesField.customValidation = (wn: WhatsNewEntity) =>
            wn.messages?.some(m => m.culture?.name === defaultCulture) ? null
                : WhatsNewMessage._0ContiansNoVersionForCulture1.niceToString(
                    messagesField.niceToString(), defaultCulture);

        registerRelatedConfig(QueryEntity, async lite =>
            await QueryAuthLogic.isQueryAllowed(QueryLogic.toQueryName(lite.toString()), true));
        registerRelatedConfig(PermissionSymbol, async lite =>
            await PermissionAuthLogic.isAuthorized((await SymbolLogic.cache(PermissionSymbol)).toSymbol(lite.toString())));

    }

    /** The condition an app grants ordinary users. */
    export function registerPublishedTypeCondition(typeCondition: TypeConditionSymbol): void {
        TypeConditionLogic.registerCompile(WhatsNewEntity, typeCondition, wn => wn.status === WhatsNewState.Publish);
    }

    /** Teach the module how to reach — and how to icon — a `Related` type of an app's own. */
    export function registerRelatedConfig<T extends Entity>(
        type: Type<T>, isAuthorized: (lite: Lite<T>) => Promise<boolean>,
    ): void {
        relatedConfigs.set(type, isAuthorized as (lite: Lite<Entity>) => Promise<boolean>);
    }

    /**
     * Every news item this user may see, each with whether they have read it.
     *
     * The ROW filter comes from the query itself (see the header); the RELATED check is this module's own,
     * and a `Related` whose type has no registered config THROWS — silently hiding or silently showing
     * would both be wrong.
     */
    export async function getWhatNews(): Promise<{ wn: WhatsNewEntity, isRead: boolean }[]> {
        const all = await table(WhatsNewEntity).toArray() as WhatsNewEntity[];
        const read = await readByCurrentUser();

        const result: { wn: WhatsNewEntity, isRead: boolean }[] = [];
        for (const wn of all) {
            if (!await isRelatedAuthorized(wn))
                continue;
            result.push({ wn, isRead: read.has(wn.toLite().key()) });
        }
        return result;
    }

    /** The same visibility rules for one item; null when it is not visible. */
    export async function getWhatNew(id: string | number): Promise<WhatsNewEntity | null> {
        const found = await table(WhatsNewEntity).filter(wn => wn.id == id).singleOrNull() as WhatsNewEntity | null;
        if (found == null || !await isRelatedAuthorized(found))
            return null;
        return found;
    }

    async function isRelatedAuthorized(wn: WhatsNewEntity): Promise<boolean> {
        if (wn.related == null)
            return true;
        const config = relatedConfigs.get(wn.related.entityType);
        if (config == undefined)
            throw new Error(`No related config registered for '${wn.related.entityType.name}' — call WhatsNewLogic.registerRelatedConfig`);
        return await config(wn.related);
    }

    /** The lite keys of the news items the CURRENT user has already read, read with authorization off. */
    async function readByCurrentUser(): Promise<Set<string>> {
        const user = UserHolder.currentUserLite();
        if (user == null)
            return new Set();

        const logs = await ExecutionMode.global(() => table(WhatsNewLogEntity)
            .filter(l => l.user.is(user))
            .map(l => l.whatsNew)
            .toArray()) as Lite<WhatsNewEntity>[];

        return new Set(logs.map(l => l.key()));
    }

    /**
     * The message for the request's culture, then its LANGUAGE, then the
     * default culture, then simply the first. A news item always shows something.
     */
    export function getCurrentMessage(wn: WhatsNewEntity): WhatsNewMessageEntity {
        const current = CultureInfo.currentUICulture();
        const language = current.tryBefore("-") ?? current;

        return wn.messages.find(m => m.culture?.name === current)
            ?? wn.messages.find(m => m.culture?.name === language)
            ?? wn.messages.find(m => m.culture?.name === defaultCulture)
            ?? wn.messages[0];
    }

    /** In memory — used by the route that records a read. */
    export async function isReadByCurrentUser(wn: WhatsNewEntity): Promise<boolean> {
        return (await readByCurrentUser()).has(wn.toLite().key());
    }
}

/**
 * A named function the include's `withStateMachine` calls. Save is a plain Execute with an EMPTY body: the
 * operation exists so the entity has one, and the save itself is what it does.
 */
function registerWhatsNewOperations(sm: FluentStateMachine<WhatsNewEntity, WhatsNewState>): void {
    sm.parent.withSave(WhatsNewOperation.Save);

    sm.withExecute(WhatsNewOperation.Publish, {
        fromStates: [WhatsNewState.Draft],
        toStates: [WhatsNewState.Publish],
        canBeNew: true,
        execute: wn => { wn.status = WhatsNewState.Publish; },
    });

    sm.withExecute(WhatsNewOperation.Unpublish, {
        fromStates: [WhatsNewState.Publish],
        toStates: [WhatsNewState.Draft],
        execute: wn => { wn.status = WhatsNewState.Draft; },
    });

    sm.parent.withDelete(WhatsNewOperation.Delete);
}

// The two expressions, as `withQuoted` PROTOTYPE members (the idiom @altea/altea-view-log uses): a
// registered expression needs a quoted member to point at, and both bodies are queries, so they are
// server-only.
WhatsNewEntity.prototype.whatsNewLogs = withQuoted(function (this: WhatsNewEntity): IQuery<WhatsNewLogEntity> {
    return table(WhatsNewLogEntity).filter(log => log.whatsNew.is(this));
});

// A quoted member's body must be ONE return statement (the transformer stamps that expression), so the
// current user is read INSIDE it — the transformer captures the call as a constant, the way
// @altea/altea-view-log's viewLogMyLast does. The declared return type is a PROMISE because `some` is a
// query terminal, as @altea/altea-workflow's `currentUserHasNotification` declares it; as a query TOKEN it
// is a plain boolean column.
WhatsNewEntity.prototype.isRead = withQuoted(function (this: WhatsNewEntity): Promise<boolean> {
    return table(WhatsNewLogEntity).some(log => log.whatsNew.is(this) && log.user.is(UserHolder.currentUserLite()));
});
