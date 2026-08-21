import "@altea/altea/server/dynamicQuery/dQueryable"; // augments Query with .toDQueryable()
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { ManualDynamicQueryCore } from "@altea/altea/server/dynamicQuery/dynamicQueryCore";
import type { ResultTable } from "@altea/altea/server/dynamicQuery/resultTable";
import { DEnumerable } from "@altea/altea/server/dynamicQuery/dEnumerable";
import { ClassType } from "@altea/altea/server/runtimeTypes";
import {
    Column, FilterCondition, FilterGroup, FilterGroupOperation, FilterOperation, Order, Pagination,
    type Filter, type QueryRequest,
} from "@altea/altea/server/dynamicQuery/requests";
import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { Temporal } from "@altea/altea/data/basics";
import { Lite } from "@altea/altea/data/lite";
import { UserEntity } from "@altea/altea-auth/data/User";
import type { AzureADConfigurationEmbedded } from "@altea/altea-auth-azuread/data/AzureAD";
import { AzureADLogic } from "@altea/altea-auth-azuread/server/AzureADLogic";
import { MicrosoftGraph, type GraphCollection } from "@altea/altea-auth-azuread/server/MicrosoftGraph";
import {
    GraphFieldUsage, MicrosoftGraphQueryConverter,
} from "@altea/altea-auth-azuread/server/MicrosoftGraphQueryConverter";
import {
    RecipientEmbedded, RemoteEmailFolderModel, RemoteEmailMessageMessage, RemoteEmailMessageRowModel,
} from "../data/RemoteEmailMessage";
import { RemoteEmailsServer } from "./RemoteEmailsServer";

// Port of Signum.Mailing.MicrosoftGraph/RemoteEmails' RemoteEmailsLogic.cs — the search page over a USER'S
// REAL OUTLOOK MAILBOX. Every row comes from a live Microsoft Graph call; nothing is stored.
//
// altea divergences, documented inline:
//  - `QueryLogic.Queries.Register(RemoteEmailMessageQuery.RemoteEmailMessages, () => DynamicQueryCore.Manual(…))`
//    becomes `QueryLogic.queries.register(RemoteEmailMessageRowModel, () => new ManualDynamicQueryCore(…))`:
//    altea has no QueryDescription, so the query's NAME is its row model and the column captions are the
//    model's own `@niceName`s. That also removes Signum's `.ColumnProperyRoutes(...)` calls, whose whole job
//    was to tell the client which PropertyRoute each anonymous-projection column came from.
//  - `Implementations.By(typeof(UserEntity)) /*Lie*/` on the query's entity column is unnecessary: the row
//    model DECLARES `entity: Lite<UserEntity> | null`, so the implementation is structural.
//  - `FilterValueConverter.SpecificConverters.Add(new RemoteEmailFolderConverter())` — the XML/URL form of a
//    folder filter value — becomes the CLIENT-side `Finder.Encoder.encodeModel` / `decodeModel` pair
//    (RemoteEmailsClient), because altea parses and formats filter values client-side.
//  - `ReflectionServer.RegisterLike(typeof(RemoteEmailMessageQuery), …)` has no counterpart: altea ships ONE
//    metadata blob whose per-query visibility already follows query authorization.
//  - The filters/orders are ALSO re-applied IN MEMORY (as altea-auth-azuread's directory queries do): Graph
//    silently loosens what it cannot express, and the rows are already in hand.

export namespace RemoteEmailsLogic {

    /** Signum's `HardCodedCategories` — an app that manages its own category list overrides the Graph one. */
    export let hardCodedCategories: (() => string[]) | null = null;

    /** Signum's `GetTokenCredentials` — which Entra registration a mailbox is read with. */
    export let getGraphConfig: (mailboxId: string) => AzureADConfigurationEmbedded =
        () => AzureADLogic.requireConfig();

    /** Signum's `Converter` — replaceable, because `GetExpansionPropertyId` is the app's extension point.
     *  Assigned below the class declaration (a namespace initializer runs before it). */
    export let converter: MessageMicrosoftGraphQueryConverter = null!;

    /**
     * Signum's `GetMailbox` — the DIRECTORY OBJECT ID of a user's mailbox, which is what every Graph call in
     * this feature is addressed by. Signum reads it off the user's lite MODEL (`UserLiteModel.ExternalId`);
     * altea has no lite model, so the user's own `externalId` column is read instead.
     */
    export let getMailbox: (user: Lite<UserEntity>) => Promise<string> = user =>
        mailboxOfUserId(user.id, user.toString());

    /**
     * The mailbox id for a user by PRIMARY KEY. This is what the routes take (see RemoteEmailsServer's
     * header): altea has no lite model, so the client never holds the directory object id — and having the
     * SERVER resolve it also means a caller cannot ask for an arbitrary mailbox by naming its oid.
     */
    export async function mailboxOfUserId(id: string | number | null, display?: string): Promise<string> {
        const userId = id;
        const externalId = await table(UserEntity).filter(u => u.id == userId).map(u => u.externalId).firstOrNull();

        if (externalId == null || externalId === "")
            throw new Error(RemoteEmailMessageMessage.User0HasNoMailbox.niceToString(display ?? String(id)));

        return externalId;
    }

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        QueryLogic.queries.register(RemoteEmailMessageRowModel, () =>
            new ManualDynamicQueryCore(RemoteEmailMessageRowModel, async request => {
                // WHOSE mailbox. Signum extracts the `User` EqualTo condition and throws without it; so does
                // this — an unscoped "all mailboxes" read is not something Graph or this feature offers.
                const { extracted: userFilter, rest } = extractFilter(request, "user");
                const user = userFilter?.value as Lite<UserEntity> | undefined;
                if (user == null)
                    throw new Error(RemoteEmailMessageMessage.UserFilterNotFound.niceToString());

                const mailbox = await getMailbox(user);
                const config = getGraphConfig(mailbox);

                // https://learn.microsoft.com/en-us/graph/api/user-list-messages — see fixFiltersAndOrders.
                const { filters, orders } = fixFiltersAndOrders(rest, request.orders);

                const graphColumns = request.columns.filter(c => inMicrosoftGraph(c.token));

                const response = await MicrosoftGraph.get<GraphCollection<GraphMailMessage>>(
                    config, `users/${mailbox}/messages`,
                    {
                        filter: converter.getFilters(filters),
                        search: converter.getSearch(filters),
                        select: converter.getSelect(graphColumns),
                        orderby: converter.getOrderBy(orders.filter(o => inMicrosoftGraph(o.token))),
                        expand: converter.getExpand(request.columns),
                        top: converter.getTop(request.pagination),
                        count: true,
                    },
                    // Without ImmutableId a message's id changes when it is MOVED, so the id a row carries
                    // would stop addressing the message the moment the user filed it somewhere.
                    { Prefer: "IdType='ImmutableId'" });

                const folders = await mailFolders(config, mailbox);

                const rows = (response.value ?? []).map(m => toRowModel(m, folders, user));

                return finish(rows, request, rest, response["@odata.count"]);
            }));

        if (sb.webBuilder)
            RemoteEmailsServer.start(sb.webBuilder);
    }

    /** Signum's mail-folder lookup — `folderId -> RemoteEmailFolderModel`, so a row can show a folder NAME. */
    export async function mailFolders(config: AzureADConfigurationEmbedded, mailbox: string): Promise<Map<string, RemoteEmailFolderModel>> {
        const response = await MicrosoftGraph.get<GraphCollection<{ id?: string; displayName?: string }>>(
            config, `users/${mailbox}/mailFolders`,
            { select: ["displayName"], top: 100, extra: { includeHiddenFolders: "true" } });

        return new Map((response.value ?? [])
            .filter(f => f.id != undefined)
            .map(f => [f.id!, RemoteEmailFolderModel.create({ folderId: f.id!, displayName: f.displayName ?? "" })]));
    }

    /** Signum's `RemoteEmailFolderModel` fallback for a folder the listing did not include. */
    export function folderOf(folders: Map<string, RemoteEmailFolderModel>, parentFolderId: string | undefined): RemoteEmailFolderModel | null {
        if (parentFolderId == undefined)
            return null;

        return folders.get(parentFolderId)
            ?? RemoteEmailFolderModel.create({ folderId: parentFolderId, displayName: "Unknown" });
    }

    /** Signum's `ToRecipientEmbedded(Recipient)`. */
    export function toRecipientEmbedded(r: GraphRecipient | undefined): RecipientEmbedded | null {
        if (r == undefined)
            return null;

        return RecipientEmbedded.create({
            emailAddress: r.emailAddress?.address ?? null,
            name: r.emailAddress?.name ?? null,
        });
    }

    /** Graph hands out UTC ISO instants; altea's date/time family is Temporal (see CLAUDE.md). */
    export function toPlainDateTime(iso: string | undefined): Temporal.PlainDateTime | null {
        if (iso == undefined || iso === "")
            return null;

        return Temporal.Instant.from(iso).toZonedDateTimeISO("UTC").toPlainDateTime();
    }

    function toRowModel(
        m: GraphMailMessage,
        folders: Map<string, RemoteEmailFolderModel>,
        user: Lite<UserEntity>,
    ): RemoteEmailMessageRowModel {
        return RemoteEmailMessageRowModel.create({
            entity: null,
            messageId: m.id ?? null,
            subject: m.subject ?? null,
            from: toRecipientEmbedded(m.from),
            toRecipients: (m.toRecipients ?? []).map(r => r.emailAddress?.name ?? r.emailAddress?.address ?? "").join(", "),
            createdDateTime: toPlainDateTime(m.createdDateTime),
            receivedDateTime: toPlainDateTime(m.receivedDateTime),
            sentDateTime: toPlainDateTime(m.sentDateTime),
            lastModifiedDateTime: toPlainDateTime(m.lastModifiedDateTime),
            isRead: m.isRead ?? null,
            isDraft: m.isDraft ?? null,
            hasAttachments: m.hasAttachments ?? null,
            folder: folderOf(folders, m.parentFolderId),
            categories: (m.categories ?? []).join(", "),
            user,
            extension0: converter.getExtension(m, 0),
            extension1: converter.getExtension(m, 1),
            extension2: converter.getExtension(m, 2),
            extension3: converter.getExtension(m, 3),
        });
    }

    /**
     * Signum's `response.Value.Skip(skip).Select(request.Columns).OrderBy(request.Orders).WithCount(...)`.
     * The local SKIP is not an optimisation to drop: Graph pages with an opaque cursor, so there is no
     * `$skip` — the converter asks for `elementsPerPage * currentPage` rows and the wanted page is the TAIL.
     */
    function finish(rows: unknown[], request: QueryRequest, filters: Filter[], odataCount: number | undefined): ResultTable {
        const skip = request.pagination instanceof Pagination.Paginate ? request.pagination.skip() : 0;

        const all = DEnumerable.fromEntity(new ClassType(RemoteEmailMessageRowModel), rows)
            .where(filters)
            .orderBy(request.orders);

        const page = skip === 0 ? all : new DEnumerable(all.collection.slice(skip), all.context);

        return page
            .withCount(odataCount ?? all.collection.length)
            .toResultTable(request.columns, request.pagination);
    }

    /** Pull ONE `EqualTo` condition on `key` out of the request's filters (Signum's `Filters.Extract`). */
    function extractFilter(request: QueryRequest, key: string): { extracted: FilterCondition | undefined; rest: Filter[] } {
        let extracted: FilterCondition | undefined;
        const rest = request.filters.filter(f => {
            if (extracted == undefined && f instanceof FilterCondition
                && f.token.fullKey() === key && f.operation === FilterOperation.EqualTo) {
                extracted = f;
                return false;
            }
            return true;
        });
        return { extracted, rest };
    }

    /**
     * Signum's FixFiltersAndOrders, and the comment it links to is the whole story:
     * https://learn.microsoft.com/en-us/graph/api/user-list-messages#using-filter-and-orderby-in-the-same-query
     *
     * Graph refuses `$filter` + `$orderby` on messages unless the ORDER-BY fields appear FIRST in the filter,
     * in the same order. So: drop an order on `Id` (never sortable), give up ordering entirely when a
     * `$search` is in play (Graph ignores `$orderby` then anyway), and otherwise move each ordered field's
     * condition to the front — inventing a vacuously-true one (`x eq v OR x ne v`) for an ordered field that
     * has no filter of its own.
     */
    function fixFiltersAndOrders(filters: Filter[], orders: Order[]): { filters: Filter[]; orders: Order[] } {
        const keptOrders = orders.filter(o => o.token.fullKey() !== "messageId");

        if (filters.length === 0)
            return { filters, orders: keptOrders };

        if (filters.some(f => f instanceof FilterCondition && f.operation === FilterOperation.Contains))
            return { filters, orders: [] };

        const remaining = [...filters];
        const reordered: Filter[] = [];

        for (const order of keptOrders) {
            const index = remaining.findIndex(f => f instanceof FilterCondition && f.token.fullKey() === order.token.fullKey());
            if (index >= 0)
                reordered.push(remaining.splice(index, 1)[0]!);
            else
                reordered.push(trivialFilter(order.token));
        }

        return { filters: [...reordered, ...remaining], orders: keptOrders };
    }

    /** Signum's CreateTrivialFilter — `token == v OR token != v`, which is true for every row. */
    function trivialFilter(token: QueryToken): Filter {
        const typeName = token.type.typeName;
        const value: unknown =
            typeName === "String" ? "124536786543214567" :
                typeName === "Boolean" ? true :
                    typeName === "PlainDate" ? Temporal.PlainDate.from("1990-01-01") :
                        typeName === "PlainDateTime" ? Temporal.PlainDateTime.from("1990-01-01T00:00:00") :
                            typeName === "Number" || typeName === "Decimal" ? 0 :
                                null;

        return new FilterGroup(FilterGroupOperation.Or, undefined, [
            new FilterCondition(token, FilterOperation.EqualTo, value),
            new FilterCondition(token, FilterOperation.DistinctTo, value),
        ]);
    }

    /** Signum's InMSGRaph (the typo is Signum's) — the two columns Graph knows nothing about. */
    function inMicrosoftGraph(token: QueryToken): boolean {
        const key = token.fullKey();
        return !key.startsWith("entity") && !key.startsWith("user");
    }
}

/**
 * Port of Signum's MessageMicrosoftGraphQueryConverter — the message-specific overrides on top of
 * altea-auth-azuread's converter: the folder columns collapse to `parentFolderId`, a recipient's members map
 * to `emailAddress/address` / `emailAddress/name`, and the Extension columns become single-value extended
 * properties (which an app enables by overriding `getExpansionPropertyId`).
 */
export class MessageMicrosoftGraphQueryConverter extends MicrosoftGraphQueryConverter {

    override toGraphField(token: QueryToken, usage: GraphFieldUsage): string {
        const key = token.fullKey();
        if (key.startsWith("folder"))
            return "parentFolderId";

        // A `.Element` step over a collection column is not a Graph field: the collection itself is.
        const target = token.isElement() && token.parent != undefined ? token.parent : token;

        const parts: string[] = [];
        for (let t: QueryToken | undefined = target; t != undefined; t = t.parent) {
            if (t.key === "")
                continue;
            // The row model's `messageId` is Graph's `id` (see the model's note on why it cannot be `id`).
            parts.unshift(t.key === "messageId" ? "id" : t.key);
        }

        const field = parts.join("/");

        // RecipientEmbedded's two members live under Graph's `emailAddress` complex property.
        return field
            .replace(/\/emailAddress$/, "/emailAddress/address")
            .replace(/\/name$/, "/emailAddress/name")
            + (usage === GraphFieldUsage.Select ? "" : "");
    }

    override getOrderBy(orders: Order[]): string[] | null {
        return super.getOrderBy(orders);
    }

    override getSelect(columns: Column[]): string[] | null {
        // An Extension column is not a field: it arrives through `$expand` (see getExpand).
        return super.getSelect(columns.filter(c => !c.token.fullKey().startsWith("extension")));
    }

    override toFilter(f: Filter): string | null {
        if (f instanceof FilterCondition) {
            const key = f.token.fullKey();

            if (key.startsWith("extension")) {
                const id = this.getExpansionPropertyId(extensionIndex(key));
                if (id == null)
                    return null;

                return `singleValueExtendedProperties/Any(ep: ep/id eq '${id}' and `
                    + `${this.buildCondition("ep/value", f.operation, this.toStringValue(f.value))})`;
            }

            // A folder filter carries a RemoteEmailFolderModel; Graph wants its id.
            if (f.value instanceof RemoteEmailFolderModel)
                return this.buildCondition(this.toGraphField(f.token, GraphFieldUsage.Filter), f.operation,
                    this.toStringValue(f.value.folderId));
        }

        return super.toFilter(f);
    }

    /** Signum's GetExpand — pull each requested Extension column's extended property into the response. */
    getExpand(columns: Column[]): string[] | null {
        const expands = columns
            .map(c => c.token.fullKey())
            .filter(key => key.startsWith("extension"))
            .map(key => this.getExpansionPropertyId(extensionIndex(key)))
            .filter((id): id is string => id != null)
            .map(id => `singleValueExtendedProperties($filter=id eq '${id}')`);

        return expands.length === 0 ? null : [...new Set(expands)];
    }

    /** Signum's GetExtension — read one extended property off a returned message. */
    getExtension(m: GraphMailMessage, index: number): string | null {
        const id = this.getExpansionPropertyId(index);
        if (id == null || m.singleValueExtendedProperties == undefined)
            return null;

        return m.singleValueExtendedProperties.find(p => p.id === id)?.value ?? null;
    }

    /**
     * Signum's GetExpansionPropertyId — null by default, which is what makes the four Extension columns
     * INERT until an app subclasses this converter and names its own extended properties (e.g.
     * `"String {6A9A7B04-…} Name CommunicationId"`). Install the subclass on
     * `RemoteEmailsLogic.converter`.
     */
    getExpansionPropertyId(_index: number): string | null {
        return null;
    }
}

// The default converter, installed once the class exists (see the field's note).
RemoteEmailsLogic.converter = new MessageMicrosoftGraphQueryConverter();

function extensionIndex(fullKey: string): number {
    return Number.parseInt(fullKey.substring("extension".length), 10);
}

// ---- The Graph shapes this feature reads ---------------------------------------------------------------

export interface GraphRecipient {
    emailAddress?: { address?: string; name?: string };
}

export interface GraphMailMessage {
    id?: string;
    subject?: string;
    body?: { content?: string; contentType?: string };
    from?: GraphRecipient;
    toRecipients?: GraphRecipient[];
    ccRecipients?: GraphRecipient[];
    bccRecipients?: GraphRecipient[];
    createdDateTime?: string;
    lastModifiedDateTime?: string;
    receivedDateTime?: string;
    sentDateTime?: string;
    isRead?: boolean;
    isDraft?: boolean;
    hasAttachments?: boolean;
    parentFolderId?: string;
    categories?: string[];
    webLink?: string;
    attachments?: GraphAttachment[];
    singleValueExtendedProperties?: { id?: string; value?: string }[];
}

export interface GraphAttachment {
    id?: string;
    name?: string;
    size?: number;
    lastModifiedDateTime?: string;
    isInline?: boolean;
    contentId?: string;
    contentBytes?: string;
    contentType?: string;
}
