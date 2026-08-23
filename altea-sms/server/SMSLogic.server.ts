import "@altea/altea/server";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import "@altea/altea/server/operationFluentInclude";
import "@altea/altea/data/globals";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { table } from "@altea/altea/server/table";
import { retrieve } from "@altea/altea/server/Database";
import { graph } from "@altea/altea/server/graphBuilder";
import { Graph } from "@altea/altea/server/graph";
import { Saver } from "@altea/altea/server/saver";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import {
    Column, QueryRequest, Order, FilterCondition, FilterOperation, type Filter,
} from "@altea/altea/server/dynamicQuery/requests";
import type { ResultTable } from "@altea/altea/server/dynamicQuery/resultTable";
import { SubTokensOptionsAll, type QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { withQuoted } from "@altea/altea/data/decorators";
import { Clock } from "@altea/altea/data/utils/clock";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { cultureNameOf } from "@altea/altea/data/cultureInfoEntity";
import { Entity, type Type } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import type { IQuery } from "@altea/altea/data/iquery";
import { Temporal } from "@altea/altea/data/basics";
import { TextTemplateParser } from "@altea/altea-templating/server/TextTemplateParser.server";
import { TextTemplateParameters } from "@altea/altea-templating/server/TextTemplateParser.Nodes.server";
import type { BlockNode } from "@altea/altea-templating/server/TextTemplateParser.Nodes.server";
import { QueryContext } from "@altea/altea-templating/server/ValueProviders.server";
import { TemplatingLogic } from "@altea/altea-templating/server/TemplatingLogic.server";
import { CultureInfoLogic } from "@altea/altea/server/cultureInfoLogic";
import {
    MessageLengthExceeded, MultipleSMSModel, SMSMessageEntity, SMSMessageOperation, SMSMessageState,
    SMSSendPackageEntity, SMSTemplateEntity, SMSTemplateEntity_Message, SMSTemplateMessage,
    SMSTemplateOperation, SMSUpdatePackageEntity,
    SMSConfigurationEmbedded,
    type ISMSOwnerEntity, type SMSOwnerData,
} from "../data/SMS";
import { SMSCharacters, SMSCharactersMessage } from "../data/SMSCharacters";
import { SMSModelLogic, type ISMSModel } from "./SMSModelLogic.server";

// Port of Signum.SMS's SMSLogic.cs — the module's core: the two tables, the PROVIDER seam (nobody sends an
// SMS without one), the template renderer, and the message state machine.
//
// altea divergences:
//  - **`ISMSProvider` is a slot the app fills, and there is no built-in.** Same as Signum, which ships none
//    either (Southwind passes `null`) — an SMS gateway is a paid third-party API, so the module defines the
//    three calls and an app supplies them.
//  - **`SendAsyncSMS` is dropped.** Signum's is `Task.Factory.StartNew(() => SendSMS(message))` — a detached
//    task. In Node a floating promise is an unhandled rejection waiting to happen and races process exit; a
//    caller who wants fire-and-forget has @altea/altea-processes (which is what the Send PROCESS is for) or
//    can simply not await. The same call @altea/altea-view-log made for its log write.
//  - **`OperationLogic.AllowSave<T>()` has no counterpart**: altea's Saver does not refuse a save outside an
//    operation, so the ambient "allow" scopes disappear.
//  - **the query is executed through `QueryLogic.queries.executeQueryAsync`** with hand-built Columns /
//    Filters / Orders, exactly as @altea/altea-email's EmailMessageBuilder does — there is no
//    QueryDescription to thread, so a token is resolved by `QueryLogic.getToken(queryName, …)`.
//  - **`GetCultureMessage` matches on the CultureInfoEntity lite**, and the fallback chain is Signum's:
//    the forced culture, else the owner's, else the configured default.
//  - **`ExceptionLogic.DeleteLogs`** (both handlers, messages and orphaned packages) is NOT ported — altea
//    has no log-retention machinery, the note every other module carries.
//  - **`SMSTemplateEntity.ParseData` / the `Retrieved` + web `AfterDeserialization` re-parse are gone**:
//    altea resolves query tokens CLIENT-side (there is no QueryDescription to parse against), the same
//    decision altea-user-queries / altea-email document. What survives is the PreSaving re-print, which is
//    what catches a template's syntax error at save time.
//  - `SMSMessages` expressions: registered PER CONCRETE TYPE from a registry (`registerSMSOwner`) rather
//    than from a reflection scan over `ISMSOwnerEntity` implementors — TypeScript interfaces are erased.

/** Signum's `ISMSProvider` — the three calls a gateway must answer. */
export interface ISMSProvider {
    /** Send one message, returning the provider's own ticket id (Signum's SMSSendAndGetTicket). */
    smsSendAndGetTicket(message: SMSMessageEntity): Promise<string>;
    /** Send the same text to many numbers, returning one ticket id per number, in order. */
    smsMultipleSendAction(template: MultipleSMSModel, phones: string[]): Promise<string[]>;
    /** Ask the gateway what became of a sent message. */
    smsUpdateStatusAction(message: SMSMessageEntity): Promise<SMSMessageState>;
}

export namespace SMSLogic {

    let getConfiguration: () => SMSConfigurationEmbedded = () => {
        throw new Error("SMSLogic.start was not called with a configuration accessor");
    };

    export function configuration(): SMSConfigurationEmbedded {
        return getConfiguration();
    }

    /** Signum's `SMSLogic.Provider` — a settable slot, unset by default. */
    export let provider: ISMSProvider | undefined;

    export function getProvider(): ISMSProvider {
        if (provider == null)
            throw new Error("No ISMSProvider set (SMSLogic.provider)");
        return provider;
    }

    export let smsTemplatesLazy: ResetLazy<SMSTemplateEntity[]> = null!;

    /** Signum's memoised parse trees, off the entity — the shape altea-email's EmailTemplateLogic uses. */
    const parsedNodes = new WeakMap<object, BlockNode>();

    /** The concrete types that declared themselves SMS owners (see data/SMS.ts's ISMSOwnerEntity note). */
    const smsOwners: Type<Entity>[] = [];

    export function start(
        sb: SchemaBuilder,
        options: { provider?: ISMSProvider; getConfiguration: () => SMSConfigurationEmbedded },
    ): void {
        if (sb.alreadyDefined(start))
            return;

        getConfiguration = options.getConfiguration;
        provider = options.provider;

        TemplatingLogic.start(sb);

        sb.include(SMSMessageEntity).withQuery();

        // Signum's `WithUniqueIndex(t => t.Model, where: t => t.Model != null && t.IsActive)`: at most ONE
        // active template per model, which is what `getDefaultTemplate`'s SingleEx relies on.
        sb.include(SMSTemplateEntity)
            .withUniqueIndex(t => t.model, t => t.model != null && t.isActive == true)
            .withQuery();

        smsTemplatesLazy = sb.globalLazy(
            () => table(SMSTemplateEntity).toArray() as Promise<SMSTemplateEntity[]>,
            { invalidateWith: [SMSTemplateEntity] });

        SMSModelLogic.start(sb);

        // Signum's PreSaving: re-print each message through the parser, so a stored template is in canonical
        // form AND a syntax error is caught at save time rather than at send time.
        sb.schema.entityEvents(SMSTemplateEntity).preSaving.push(template => {
            const queryName = tryQueryName(template);
            for (const message of template.messages) {
                message.message = TextTemplateParser.parse(message.message, queryName, undefined).toString();
                parsedNodes.delete(message);
            }
        });

        // Signum's StaticPropertyValidation on Messages: there must be a message for the CONFIGURED default
        // culture. It cannot live on the entity (it depends on the configuration), which is why Signum also
        // registers it here.
        sb.schema.entityEvents(SMSTemplateEntity).preSaving.push(template => {
            const dc = configuration().defaultCulture;
            if (dc != null && !template.messages.some(m => cultureNameOf(m.culture) === dc))
                throw new Error(SMSTemplateMessage.ThereMustBeAMessageFor0.niceToString(dc));
        });

        SMSMessageGraph.register();
        SMSTemplateGraph.register();
    }

    // ---- the owner registry + its expression ---------------------------------------------------------

    /**
     * Signum's `Schema_SchemaCompleted` loop, made explicit: every type that can be the SUBJECT of an SMS
     * registers itself, which stamps `smsMessages()` on its prototype and registers the sub-token. Signum
     * scans `TypeLogic.TypeToEntity` for `ISMSOwnerEntity` implementors; a TypeScript interface is erased, so
     * there is nothing to scan — and altea keys an extension token on a CONSTRUCTOR anyway, so the
     * registration has to be per concrete type (altea-alert's `registerExpressions` makes the same call).
     */
    export function registerSMSOwner<T extends Entity>(type: Type<T>): void {
        smsOwners.push(type as unknown as Type<Entity>);

        const proto = (type as unknown as { prototype: Record<string, unknown> }).prototype;
        proto.smsMessages = withQuoted(function (this: Entity): IQuery<SMSMessageEntity> {
            return table(SMSMessageEntity).filter(m => m.referred!.is(this));
        });

        QueryLogic.expressions.register(type, (e: ISMSOwnerEntity) => e.smsMessages!(),
            { key: "SMSMessages", niceName: () => SMSMessageEntity.nicePluralName() });
    }

    /** Signum's `GetAllTypes` — the clean names the client's quick link checks against. */
    export function allOwnerTypes(): Type<Entity>[] {
        return [...smsOwners];
    }

    // ---- the two package navigations (Signum's three SMSMessages expressions) --------------------------

    export function messagesOfSendPackage(pack: SMSSendPackageEntity | Lite<SMSSendPackageEntity>): IQuery<SMSMessageEntity> {
        return table(SMSMessageEntity).filter(m => m.sendPackage!.is(pack));
    }

    export function messagesOfUpdatePackage(pack: SMSUpdatePackageEntity | Lite<SMSUpdatePackageEntity>): IQuery<SMSMessageEntity> {
        return table(SMSMessageEntity).filter(m => m.updatePackage!.is(pack));
    }

    // ---- templates ------------------------------------------------------------------------------------

    /** The template's query as a QueryName, or undefined (a message-only template). */
    export function tryQueryName(template: SMSTemplateEntity): QueryName | undefined {
        return template.query == null ? undefined : QueryLogic.tryGetQueryNameByKey(template.query.key);
    }

    /** Signum's `GetCultureMessage(template, ci)`. */
    export function getCultureMessage(template: SMSTemplateEntity, culture: string): SMSTemplateEntity_Message | undefined {
        return template.messages.find(m => cultureNameOf(m.culture) === culture);
    }

    /** The message row's parse tree, memoised per row (altea-email's same WeakMap). */
    function messageNode(template: SMSTemplateEntity, message: SMSTemplateEntity_Message): BlockNode {
        const cached = parsedNodes.get(message);
        if (cached != null)
            return cached;
        const node = TextTemplateParser.parse(message.message, tryQueryName(template), undefined);
        parsedNodes.set(message, node);
        return node;
    }

    /**
     * Signum's `CheckLength(result, template)`: optionally strip non-GSM characters, then apply the
     * template's over-length policy — refuse, allow, or prune to what fits.
     */
    export function checkLength(text: string, template: SMSTemplateEntity): string {
        let result = template.removeNoSMSCharacters ? SMSCharacters.removeNoSMSCharacters(text) : text;

        const remaining = SMSCharacters.remainingLength(result);
        if (remaining >= 0)
            return result;

        switch (template.messageLengthExceeded) {
            case MessageLengthExceeded.NotAllowed:
                throw new Error(SMSCharactersMessage.TheTextForTheSMSMessageExceedsTheLengthLimit.niceToString());
            case MessageLengthExceeded.Allowed:
                return result;
            case MessageLengthExceeded.TextPruning:
                // `[...]` so a surrogate pair is never cut in half (Signum's RemoveEnd counts UTF-16 units).
                return [...result].slice(0, [...result].length - Math.abs(remaining)).join("");
        }
        return result;
    }

    /**
     * Signum's `CreateSMSMessage(template, entity, model, forceCulture)` — the renderer. With a query it runs
     * one request whose columns are the `to` token plus whatever the message texts reference, reads the
     * owner data out of the first row, and prints in that owner's culture; without one it is a plain
     * per-culture text lookup.
     */
    export async function createSMSMessage(
        templateLite: Lite<SMSTemplateEntity>,
        entity: Entity | null,
        model: ISMSModel | null,
        forceCulture?: string,
    ): Promise<SMSMessageEntity> {
        const all = await smsTemplatesLazy.value();
        const t = all.find(x => x.id != null && String(x.id) === String(templateLite.id));
        if (t == null)
            throw new Error(`SMSTemplate '${String(templateLite.id)}' not found`);

        const defaultCulture = configuration().defaultCulture;
        const queryName = tryQueryName(t);

        if (queryName == null) {
            const culture = forceCulture ?? defaultCulture;
            const message = getCultureMessage(t, culture) ?? getCultureMessage(t, defaultCulture);
            if (message == null)
                throw new Error(SMSTemplateMessage.ThereMustBeAMessageFor0.niceToString(culture));

            return SMSMessageEntity.create({
                template: t.toLite(),
                message: checkLength(message.message, t),
                from: t.from,
                editableMessage: t.editableMessage,
                state: SMSMessageState.Created,
                certified: t.certified,
            });
        }

        if (t.to == null)
            throw new Error(SMSTemplateMessage.ToMustBeSetInTheTemplate.niceToString());

        const run = async (): Promise<SMSMessageEntity> => {
            const toToken = QueryLogic.getToken(queryName, t.to!.tokenString, SubTokensOptionsAll);

            const tokens: QueryToken[] = [toToken];
            for (const m of t.messages)
                messageNode(t, m).fillQueryTokens(tokens);

            const columns = distinctTokens(tokens).map(qt => new Column(qt));

            const filters: Filter[] = model != null ? model.getFilters(queryName)
                : entity != null ? [entityFilter(queryName, entity)]
                    : (() => { throw new Error("Impossible to render an SMSTemplate when both the entity and the model are null"); })();

            const orders: Order[] = model?.getOrders(queryName) ?? [];

            const resultTable = await QueryLogic.queries.executeQueryAsync(new QueryRequest(
                queryName, filters, orders, columns, model?.getPagination(), false));

            if (resultTable.rows.length === 0)
                throw new Error(`The SMSTemplate '${t.name}' query returned no rows`);

            const toColumn = resultTable.columns.find(c => c.token.fullKey() === toToken.fullKey())!;
            const ownerData = resultTable.rows[0]!.value(resultTable.columns.indexOf(toColumn)) as SMSOwnerData | null;
            if (ownerData == null)
                throw new Error(`The SMSTemplate '${t.name}' 'to' token produced no SMSOwnerData`);

            const culture = forceCulture ?? cultureNameOf(ownerData.culture) ?? defaultCulture;
            const message = getCultureMessage(t, culture) ?? getCultureMessage(t, defaultCulture);
            if (message == null)
                throw new Error(SMSTemplateMessage.ThereMustBeAMessageFor0.niceToString(culture));

            const text = CultureInfo.withCultures(culture, () => {
                const p = new TextTemplateParameters(entity, culture, new QueryContext(queryName, resultTable));
                p.model = model ?? undefined;
                return messageNode(t, message).print(p);
            });

            return SMSMessageEntity.create({
                template: t.toLite(),
                message: checkLength(text, t),
                from: t.from,
                editableMessage: t.editableMessage,
                state: SMSMessageState.Created,
                referred: ownerData.owner,
                destinationNumber: ownerData.telephoneNumber,
                certified: t.certified,
            });
        };

        // Signum's `using (template.DisableAuthorization ? ExecutionMode.Global() : null)`.
        return t.disableAuthorization ? await ExecutionMode.global(run) : await run();
    }

    /** Signum's `SMSModelLogic.CreateSMSMessage(smsModel)` — render a model through its default template. */
    export async function createSMSMessageFromModel(model: ISMSModel, forceCulture?: string): Promise<SMSMessageEntity> {
        if (model.untypedEntity == null)
            throw new Error("Entity property not set on the SMSModel");

        // Signum's `using (ExecutionMode.SetIsolation(smsModel.UntypedEntity))`: render in the scope of the
        // entity the message is ABOUT. No-op unless @altea/altea-isolation is installed.
        return await ExecutionMode.withIsolationOf(model.untypedEntity, async () => {
            const modelType = model.modelType ?? model.untypedEntity!.constructor;
            const modelEntity = await SMSModelLogic.toSMSModelEntity(modelType);
            const template = await SMSModelLogic.getDefaultTemplate(modelEntity);
            return await createSMSMessage(template.toLite(), model.untypedEntity, model, forceCulture);
        });
    }

    // ---- sending --------------------------------------------------------------------------------------

    /**
     * Signum's `SendSMS(message)`: a comma-separated `destinationNumber` fans out into ONE message per
     * number — the first keeps this row, the rest are clones.
     */
    export async function sendSMS(message: SMSMessageEntity): Promise<void> {
        if (!message.destinationNumber.includes(",")) {
            await sendOneMessage(message);
            return;
        }

        const numbers = [...new Set(message.destinationNumber.split(",").map(n => n.trim()).filter(n => n !== ""))];
        message.destinationNumber = numbers[0]!;
        await sendOneMessage(message);

        for (const number of numbers.slice(1)) {
            await sendOneMessage(SMSMessageEntity.create({
                destinationNumber: number,
                certified: message.certified,
                editableMessage: message.editableMessage,
                from: message.from,
                message: message.message,
                referred: message.referred,
                state: SMSMessageState.Created,
                template: message.template,
                sendPackage: message.sendPackage,
                updatePackage: message.updatePackage,
                updatePackageProcessed: message.updatePackageProcessed,
            }));
        }
    }

    async function sendOneMessage(message: SMSMessageEntity): Promise<void> {
        try {
            message.messageID = await getProvider().smsSendAndGetTicket(message);
            // Signum's `Clock.Now.TruncSeconds()` — its DateTimePrecisionValidator(Seconds) on the field.
            message.sendDate = truncSeconds(Clock.now);
            message.state = SMSMessageState.Sent;
            await message.save();
        } catch (e) {
            // The FAILURE is recorded in its own transaction, so it survives the rollback of the caller's.
            const ex = await Transaction.forceNew(() => ExceptionLogic.logException(e));
            await Transaction.forceNew(async () => {
                message.exception = ex.toLite();
                message.state = SMSMessageState.SendFailed;
                await Saver.save([message]);
            });
            throw e;
        }
    }

    /** Signum's `CreateAndSendMultipleSMSMessages(template, phones)` — the gateway's bulk endpoint. */
    export async function createAndSendMultipleSMSMessages(model: MultipleSMSModel, phones: string[]): Promise<SMSMessageEntity[]> {
        const ids = await getProvider().smsMultipleSendAction(model, phones);
        const sendDate = truncSeconds(Clock.now);

        const messages: SMSMessageEntity[] = [];
        for (let i = 0; i < phones.length; i++) {
            const message = SMSMessageEntity.create({
                message: model.message,
                from: model.from,
                certified: model.certified,
                destinationNumber: phones[i]!,
                messageID: ids[i] ?? null,
                sendDate,
                state: SMSMessageState.Sent,
            });
            await message.save();
            messages.push(message);
        }
        return messages;
    }

    // ---- helpers --------------------------------------------------------------------------------------

    function truncSeconds(d: Temporal.PlainDateTime): Temporal.PlainDateTime {
        return d.with({ millisecond: 0, microsecond: 0, nanosecond: 0 });
    }

    function distinctTokens(tokens: QueryToken[]): QueryToken[] {
        const seen = new Map<string, QueryToken>();
        for (const t of tokens)
            if (!seen.has(t.fullKey()))
                seen.set(t.fullKey(), t);
        return [...seen.values()];
    }

    function entityFilter(queryName: QueryName, entity: Entity): Filter {
        return new FilterCondition(QueryLogic.getToken(queryName, "", SubTokensOptionsAll),
            FilterOperation.EqualTo, entity.toLite());
    }
}

// ---- the two graphs -------------------------------------------------------------------------------------

/** Signum's `SMSMessageGraph` — the message's state machine. */
const SMSMessageGraph = graph(SMSMessageEntity, SMSMessageState, g => {

    g.GetState = m => m.state;

    g.ConstructFrom(SMSTemplateEntity, SMSMessageOperation.CreateSMSFromTemplate, {
        canConstruct: t => t.isActive ? null : SMSCharactersMessage.TheTemplateMustBeActiveToConstructSMSMessages.niceToString(),
        toStates: [SMSMessageState.Created],
        construct: async (t, args) => {
            // Signum reads three optional args off the operation: the target (a `Lite<Entity>`, which it
            // RetrieveAndRemembers), the model, and the culture. A caller that already holds the entity may
            // pass it directly here — the client sends a lite, a server caller usually has the entity.
            const model = args.find(a => a != null && typeof a === "object" && "untypedEntity" in a) as ISMSModel | undefined;
            const culture = args.find(a => typeof a === "string") as string | undefined;

            const lite = args.find(a => a instanceof Lite) as Lite<Entity> | undefined;
            const entity = lite != null ? await retrieve(lite.entityType as Type<Entity>, lite.id!)
                : args.find(a => a instanceof Entity) as Entity | undefined;

            return await SMSLogic.createSMSMessage(t.toLite(), entity ?? null, model ?? null, culture);
        },
    });

    g.Execute(SMSMessageOperation.Send, {
        canBeNew: true,
        canBeModified: true,
        fromStates: [SMSMessageState.Created],
        toStates: [SMSMessageState.Sent],
        execute: async m => { await SMSLogic.sendSMS(m); },
    });

    g.Execute(SMSMessageOperation.UpdateStatus, {
        canExecute: m => m.state !== SMSMessageState.Created ? null
            : SMSCharactersMessage.StatusCanNotBeUpdatedForNonSentMessages.niceToString(),
        execute: async (m, args) => {
            // Signum lets the caller pass its own status resolver; default to the provider's.
            const fn = args.find(a => typeof a === "function") as ((m: SMSMessageEntity) => Promise<SMSMessageState>) | undefined
                ?? (msg => SMSLogic.getProvider().smsUpdateStatusAction(msg));

            m.state = await fn(m);
            if (m.updatePackage != null)
                m.updatePackageProcessed = true;
        },
    });
});

/** Signum's `SMSTemplateGraph`. */
const SMSTemplateGraph = graph(SMSTemplateEntity, g => {

    g.Construct(SMSTemplateOperation.Create, {
        // Signum seeds ONE message, for the configured default culture.
        construct: () => SMSTemplateEntity.create({
            messages: [SMSTemplateEntity_Message.create({
                culture: CultureInfoLogic.getCulture(SMSLogic.configuration().defaultCulture).toLite(),
            })],
        }),
    });

    g.Execute(SMSTemplateOperation.Save, {
        canBeNew: true,
        canBeModified: true,
        execute: () => { /* the PreSaving re-print is the whole behaviour */ },
    });
});
