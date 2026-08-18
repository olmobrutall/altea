import "@altea/altea/server"; // installs Entity.save()/delete()
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { Column, Order, QueryRequest, type Filter } from "@altea/altea/server/dynamicQuery/requests";
import type { ResultColumn, ResultRow } from "@altea/altea/server/dynamicQuery/resultTable";
import { SubTokensOptionsAll, type QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { QueryContext } from "@altea/altea-templating/server/ValueProviders.server";
import { TextTemplateParameters } from "@altea/altea-templating/server/TextTemplateParser.Nodes.server";
import { FilePathEmbedded } from "@altea/altea-files/data/Files";
import { QueryFilterUtils } from "./QueryFilterUtils.server";
import {
    EmailAddressSourceEnum, EmailMessageFormatEnum, EmailTemplateEntity, EmailTemplateEntity_Message,
    EmailTemplateEntity_Recipient, WhenManyFromBehaviourEnum, WhenManyRecipientsBehaviourEnum,
    WhenNoneFromBehaviourEnum, WhenNoneRecipientsBehaviourEnum,
} from "../data/EmailTemplate";
import {
    EmailFromEmbedded, EmailMessageMessage, EmailRecipientKindEnum,
    type EmailOwnerData, type EmailOwnerRecipientData,
} from "../data/Email";
import {
    EmailMessageEntity, EmailMessageEntity_Attachment, EmailMessageEntity_Recipient, EmailMessageStateEnum,
} from "../data/EmailMessage";
import type { EmailSenderConfigurationEntity } from "../data/EmailSenderConfiguration";
import { EmailLogic } from "./EmailLogic.server";
import { EmailTemplateLogic } from "./EmailTemplateLogic.server";
import type { IEmailModel } from "./EmailModelLogic.server";
import { EmailModelLogic } from "./EmailModelLogic.server";

// Port of Signum.Mailing's Templates/EmailTemplateRenderer.cs (its `EmailMessageBuilder`) — the RENDERER:
// run the template's query, work out every From × recipient-group combination, and print one message for each.
//
// altea divergences, documented inline:
//  - A From / Recipient token yields a `Lite<IEmailOwnerEntity>` (or a plain email STRING) rather than
//    Signum's queryable EmailOwnerData object — see data/Email.ts's header. `ownerDataOf` below turns either
//    into an EmailOwnerData through EmailLogic's per-type registry.
//  - Signum's `CultureInfoUtils.ChangeBothCultures(ci)` → `CultureInfo.withCultures(locale, …)`.
//  - `ex.Data["Template"/"Model"/"Entity"]` (the .NET exception payload) becomes a wrapped Error message.
//  - An attachment is produced as BYTES + a name (GeneratedAttachment) and turned into a FilePathEmbedded in
//    the EmailFileType.Attachment store here, so the generators need no file-store knowledge.

export class EmailMessageBuilder {
    private readonly queryName: QueryName | undefined;
    private senderConfig: EmailSenderConfigurationEntity | null = null;
    private queryContext: QueryContext | undefined;

    constructor(
        private readonly template: EmailTemplateEntity,
        private readonly entity: Entity | null,
        private readonly model: IEmailModel | null,
        private readonly culture: string | undefined,
    ) {
        this.queryName = EmailTemplateLogic.tryQueryName(template);
    }

    /** Signum's CreateEmailMessageInternal. */
    async createEmailMessages(): Promise<EmailMessageEntity[]> {
        this.senderConfig = (await EmailTemplateLogic.getSenderConfiguration?.(
            this.template,
            (this.model?.untypedEntity ?? this.entity)?.toLite() ?? null,
            null)) ?? null;

        if (this.queryName != undefined)
            await this.executeQuery();

        const result: EmailMessageEntity[] = [];
        for (const from of await this.getFrom())
            for (const recipients of await this.getRecipients())
                result.push(await this.createEmailMessage(from, recipients));

        return result;
    }

    private async createEmailMessage(from: EmailFromEmbedded, recipients: EmailOwnerRecipientData[]): Promise<EmailMessageEntity> {
        try {
            const config = EmailLogic.configuration();
            const ci = this.culture
                ?? EmailTemplateLogic.getCultureInfo?.(this.entity ?? this.model?.untypedEntity ?? null)
                ?? recipients.find(a => a.kind === EmailRecipientKindEnum.To)?.ownerData.culture
                ?? config.defaultCulture;

            const isHtml = this.template.messageFormat === EmailMessageFormatEnum.HtmlComplex
                || this.template.messageFormat === EmailMessageFormatEnum.HtmlSimple;

            const message = this.template.getCultureMessage(ci) ?? this.template.getCultureMessage(config.defaultCulture);
            if (message == null)
                throw new Error(`Message ${this.template.name} does not have a message for culture ${ci} (or the default)`);

            const email = EmailMessageEntity.create({
                target: (this.entity ?? this.model?.untypedEntity)?.toLite() ?? null,
                recipients: recipients.map(r => EmailMessageEntity_Recipient.create({
                    emailOwner: r.ownerData.owner,
                    emailAddress: r.ownerData.email ?? "",
                    displayName: r.ownerData.displayName,
                    kind: r.kind,
                })),
                from,
                isBodyHtml: isHtml,
                editableMessage: this.template.editableMessage,
                template: this.template.toLite(),
                state: EmailMessageStateEnum.Created,
            });

            email.attachments = await this.generateAttachments(email, ci);

            const [subject, body] = CultureInfo.withCultures(ci, () => [
                EmailTemplateLogic.subjectNode(this.template, message).print(this.printParameters(ci, false)),
                undefined,
            ] as [string, undefined]);

            email.subject = subject;
            email.body.text = (await EmailTemplateLogic.textNode(this.template, message))
                .print(this.printParameters(ci, isHtml));

            return email;
        } catch (e) {
            throw new Error(
                `Error rendering EmailTemplate '${this.template.name}'`
                + (this.entity != null ? ` for entity '${String(this.entity)}'` : "")
                + `: ${(e as Error).message}`,
                { cause: e });
        }
    }

    private printParameters(culture: string, isHtml: boolean): TextTemplateParameters {
        const p = new TextTemplateParameters(this.entity, culture, this.queryContext);
        p.isHtml = isHtml;
        p.model = this.model ?? undefined;
        return p;
    }

    /** Signum's attachment loop: the template's own rules plus its master template's. */
    private async generateAttachments(email: EmailMessageEntity, culture: string): Promise<EmailMessageEntity_Attachment[]> {
        const master = this.template.masterTemplate == null ? null
            : await EmailLogic.retrieveLite(this.template.masterTemplate);

        // A row holds the attachment RULE in its @valueField (see data/EmailTemplate.ts).
        const rules = [...this.template.attachments, ...(master?.attachments ?? [])].map(r => r.attachment);
        if (rules.length === 0)
            return [];

        const ctx = {
            template: this.template,
            culture,
            queryContext: this.queryContext,
            modelType: this.template.model == null ? undefined : EmailModelLogic.toType(this.template.model),
            entity: this.entity,
            model: this.model,
        };

        const result: EmailMessageEntity_Attachment[] = [];
        for (const rule of rules) {
            for (const generated of await EmailTemplateLogic.generateAttachment(rule, ctx)) {
                const file = FilePathEmbedded.create({
                    fileName: generated.fileName,
                    fileType: EmailLogic.attachmentFileType(),
                    binaryFile: generated.bytes,
                });

                result.push(EmailMessageEntity_Attachment.create({
                    file,
                    type: generated.type,
                    contentId: generated.contentId,
                }));
            }
        }

        void email;
        return result;
    }

    // ---- From ------------------------------------------------------------------------------------------

    /** Signum's GetFrom — zero, one or many senders, depending on the token's WhenNone / WhenMany. */
    private async getFrom(): Promise<EmailFromEmbedded[]> {
        const from = this.template.from;

        if (from != null) {
            switch (from.addressSource) {
                case EmailAddressSourceEnum.QueryToken: {
                    const qc = this.queryContext!;
                    const column = qc.column(this.token(from.token!.tokenString));
                    const groups = await this.groupOwners(qc.currentRows, column);
                    const withEmail = groups.filter(g => !!g.ownerData.email);

                    if (withEmail.length === 0) {
                        switch (from.whenNone) {
                            case WhenNoneFromBehaviourEnum.ThrowException:
                                throw new Error(groups.length === 0
                                    ? `Impossible to send ${this.template.name} because the From token (${from.token!.tokenString}) returned no result`
                                    : `Impossible to send ${this.template.name} because the From token (${from.token!.tokenString}) returned results without Email addresses`);
                            case WhenNoneFromBehaviourEnum.NoMessage:
                                return [];
                            case WhenNoneFromBehaviourEnum.DefaultFrom:
                                return [this.defaultFrom()];
                        }
                    }

                    const selected = from.whenMany === WhenManyFromBehaviourEnum.FistResult ? withEmail.slice(0, 1) : withEmail;
                    return selected.map(g => EmailFromEmbedded.fromOwnerData(g.ownerData));
                }
                case EmailAddressSourceEnum.HardcodedAddress:
                    return [EmailFromEmbedded.create({
                        emailAddress: from.emailAddress!,
                        displayName: from.displayName,
                        azureUserId: from.azureUserId,
                    })];
                case EmailAddressSourceEnum.CurrentUser: {
                    const user = await EmailLogic.currentUserOwnerData();
                    return [EmailFromEmbedded.fromOwnerData(user)];
                }
            }
        }

        const modelFrom = this.model?.getFrom() ?? null;
        if (modelFrom != null)
            return [EmailFromEmbedded.fromOwnerData(modelFrom)];

        return [this.defaultFrom()];
    }

    private defaultFrom(): EmailFromEmbedded {
        const defaultFrom = this.senderConfig?.defaultFrom;
        if (defaultFrom == null)
            throw new Error(EmailMessageMessage.DefaultFromNotFound.niceToString());
        return defaultFrom.clone();
    }

    // ---- Recipients ------------------------------------------------------------------------------------

    /** Signum's GetRecipients — the cross product of every token recipient, plus the fixed ones. */
    private async getRecipients(): Promise<EmailOwnerRecipientData[][]> {
        const tokenRecipients = this.template.recipients.filter(a => a.addressSource === EmailAddressSourceEnum.QueryToken);
        const combinations = await this.tokenRecipientsCrossProduct(tokenRecipients, 0);

        const result: EmailOwnerRecipientData[][] = [];
        for (const combination of combinations) {
            const recipients = [...combination];

            for (const tr of this.template.recipients.filter(a => a.addressSource !== EmailAddressSourceEnum.QueryToken)) {
                const ownerData = tr.addressSource === EmailAddressSourceEnum.CurrentUser
                    ? await EmailLogic.currentUserOwnerData()
                    : { owner: null, email: tr.emailAddress!, displayName: tr.displayName, culture: null, externalId: null };

                recipients.push({ ownerData, kind: tr.kind });
            }

            if (this.model != null)
                recipients.push(...this.model.getRecipients());

            // Signum adds only the configuration recipients with NO owner (an owner-bound one is a real
            // person the template already reached).
            for (const r of this.senderConfig?.additionalRecipients ?? []) {
                if (r.emailOwner != null)
                    continue;
                recipients.push({
                    ownerData: { owner: null, email: r.emailAddress, displayName: r.displayName, culture: null, externalId: null },
                    kind: r.kind,
                });
            }

            const valid = recipients.filter(r => !!r.ownerData.email);
            if (valid.length > 0)
                result.push(valid);
        }

        return result;
    }

    private async tokenRecipientsCrossProduct(
        tokenRecipients: EmailTemplateEntity_Recipient[],
        pos: number,
    ): Promise<EmailOwnerRecipientData[][]> {
        if (tokenRecipients.length === pos)
            return [[]];

        const tr = tokenRecipients[pos];
        const qc = this.queryContext!;
        const column = qc.column(this.token(tr.token!.tokenString));
        const groups = await this.groupOwners(qc.currentRows, column);
        const withEmail = groups.filter(g => !!g.ownerData.email);

        if (withEmail.length === 0) {
            switch (tr.whenNone) {
                case WhenNoneRecipientsBehaviourEnum.ThrowException:
                    throw new Error(`Impossible to send ${this.template.name} because the ${EmailRecipientKindEnum[tr.kind]} token (${tr.token!.tokenString}) returned no result with an Email address`);
                case WhenNoneRecipientsBehaviourEnum.NoMessage:
                    return [];
                case WhenNoneRecipientsBehaviourEnum.NoRecipients:
                    return await this.tokenRecipientsCrossProduct(tokenRecipients, pos + 1);
            }
        }

        const result: EmailOwnerRecipientData[][] = [];

        if (tr.whenMany === WhenManyRecipientsBehaviourEnum.SplitMessages) {
            // One message PER addressee: each group narrows the rows the rest of the template sees.
            for (const group of withEmail) {
                using _ = qc.overrideRows(group.rows);
                for (const rest of await this.tokenRecipientsCrossProduct(tokenRecipients, pos + 1))
                    result.push([{ ownerData: group.ownerData, kind: tr.kind }, ...rest]);
            }
        } else {
            const all = withEmail.map(g => ({ ownerData: g.ownerData, kind: tr.kind }));
            for (const rest of await this.tokenRecipientsCrossProduct(tokenRecipients, pos + 1))
                result.push([...all, ...rest]);
        }

        return result;
    }

    // ---- the query -------------------------------------------------------------------------------------

    /** Signum's ExecuteQuery — collect every token the template needs, then run the query once. */
    private async executeQuery(): Promise<void> {
        const queryName = this.queryName!;

        const run = async (): Promise<void> => {
            const tokens: QueryToken[] = [];

            if (this.template.from?.token != null)
                tokens.push(this.token(this.template.from.token.tokenString));

            for (const tr of this.template.recipients)
                if (tr.token != null)
                    tokens.push(this.token(tr.token.tokenString));

            for (const t of this.template.messages) {
                (await EmailTemplateLogic.textNode(this.template, t)).fillQueryTokens(tokens);
                EmailTemplateLogic.subjectNode(this.template, t).fillQueryTokens(tokens);
            }

            const modelType = this.template.model == null ? undefined : EmailModelLogic.toType(this.template.model);
            for (const a of this.template.attachments)
                EmailTemplateLogic.fillAttachmentTokens(a.attachment, { queryName, queryTokens: tokens, modelType });

            const columns = distinctTokens(tokens).map(qt => new Column(qt));

            const filters: Filter[] = this.model != null ? this.model.getFilters(queryName)
                : this.entity != null ? [QueryFilterUtils.entityFilter(queryName, this.entity)]
                    : (() => { throw new Error("Impossible to render an email template when both the entity and the model are null"); })();

            filters.push(...QueryFilterUtils.toFilterList(queryName, this.template.filters));

            const orders: Order[] = this.model?.getOrders(queryName) ?? [];
            orders.push(...this.template.orders.map(qo => new Order(this.token(qo.token.tokenString), qo.orderType as unknown as Order["orderType"])));

            const table = await QueryLogic.queries.executeQueryAsync(new QueryRequest(
                queryName, filters, orders, columns,
                this.model?.getPagination(), this.template.groupResults));

            this.queryContext = new QueryContext(queryName, table);
        };

        // Signum wraps the whole query in ExecutionMode.Global for a DisableAuthorization template; the
        // caller (EmailTemplateLogic.createEmailMessage) already does that, so this just runs.
        await run();
    }

    /** Resolve one of the template's stored token strings against the query. */
    private token(tokenString: string): QueryToken {
        return QueryLogic.getToken(this.queryName!, tokenString, SubTokensOptionsAll);
    }

    /** Group the rows by the OWNER a token column yields, and resolve each group's EmailOwnerData.
     *  The column may hold a Lite / an Entity (resolved through EmailLogic's registry) or a plain email
     *  string — see this file's header. */
    private async groupOwners(rows: readonly ResultRow[], column: ResultColumn): Promise<{ ownerData: EmailOwnerData; rows: ResultRow[] }[]> {
        const byKey = new Map<string, { value: unknown; rows: ResultRow[] }>();

        for (const row of rows) {
            const value = column.values[row.index];
            const key = ownerKey(value);
            let group = byKey.get(key);
            if (group == undefined)
                byKey.set(key, group = { value, rows: [] });
            group.rows.push(row);
        }

        const result: { ownerData: EmailOwnerData; rows: ResultRow[] }[] = [];
        for (const group of byKey.values()) {
            if (group.value == null)
                continue;
            result.push({ ownerData: await EmailLogic.ownerDataOf(group.value), rows: group.rows });
        }
        return result;
    }
}

function ownerKey(value: unknown): string {
    if (value == null) return " null";
    if (value instanceof Lite) return "l:" + value.key();
    if (value instanceof Entity) return "e:" + value.toLite().key();
    return "s:" + String(value);
}

function distinctTokens(tokens: QueryToken[]): QueryToken[] {
    const seen = new Set<string>();
    const result: QueryToken[] = [];
    for (const t of tokens) {
        const key = t.fullKey();
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(t);
    }
    return result;
}

/** Kept so a caller can force global execution around a render (Signum's ExecutionMode.Global block). */
export const renderGlobally = ExecutionMode.global;
