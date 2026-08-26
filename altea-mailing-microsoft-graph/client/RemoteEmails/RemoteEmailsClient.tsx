import * as React from "react";
import { Dropdown } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { Operations } from "@altea/altea/client/Operations";
import * as AppContext from "@altea/altea/client/AppContext";
import SelectorModal from "@altea/altea/client/SelectorModal";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { EntityBaseController } from "@altea/altea/client/Lines/EntityBase";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { ButtonBarManager } from "@altea/altea/client/Frames/ButtonBar";
import type { ButtonBarElement, ButtonsContext } from "@altea/altea/client/TypeContext";
import {
    onContextualItems, type ContextualItemsContext, type MenuItemBlock,
} from "@altea/altea/client/SearchControl/ContextualItems";
import { SearchControlLoaded } from "@altea/altea/client/SearchControl/SearchControlLoaded";
import { ajaxGet, ajaxGetRaw, ajaxPostRaw } from "@altea/altea/client/Services";
import { classes } from "@altea/altea/data/globals";
import { getQueryKey } from "@altea/altea/client/Reflection";
import { getKey as queryKeyOf } from "@altea/altea/data/dynamicQuery/queryUtils";
import { isFilterCondition, type FilterOptionParsed } from "@altea/altea/client/FindOptions";
import type { ResultRow } from "@altea/altea/data/dynamicQuery/queryRequest";
import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { SearchMessage } from "@altea/altea/data/uiMessages";
import { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { UserEntity } from "@altea/altea-auth/data/User";
import {
    RecipientEmbedded, RemoteEmailFolderModel, RemoteEmailMessageMessage, RemoteEmailMessageModel,
    RemoteEmailMessageRowModel,
} from "../../data/RemoteEmailMessage";
import RemoteEmailPopover from "./RemoteEmailPopover";
import { FolderLine } from "./FolderLine";
import { MultiMessageProgressModal } from "./MultiMessageProgressModal";

// Port of Signum.Mailing.MicrosoftGraph/RemoteEmails' RemoteEmailsClient.tsx — the whole client side of
// "browse a user's real Outlook mailbox": the query's settings, the two filter editors, the Subject cell's
// hover preview, the row actions (open / move / delete / categorise) as contextual items, and the same four
// actions as buttons on an opened message.
//
// altea divergences, documented inline:
//  - `Navigator.addSettings(new EntitySettings(T, view))` becomes `cb.configure(T).withView(…)`; the query is
//    named by its ROW MODEL (`RemoteEmailMessageRowModel`), not an enum member (see the data module).
//  - The user's mailbox is addressed by the USER's own lite id everywhere; Signum reads the directory object
//    id off `UserLiteModel.externalId`, which altea has no lite model to carry (the routes resolve it — see
//    RemoteEmailsServer's header). That also removes Signum's four "User has no OID" throws.
//  - `ContextualMenuItem` is a React element in altea (Signum wraps it in `{ fullText, menu }`).
//  - `sc.state.resultFindOptions` is read for the User filter, as in Signum; `getRowValue` and `markRows` are
//    the same methods.

export namespace RemoteEmailsClient {

    export function start(cb: ClientBuilder): void {

        cb.configure(RemoteEmailMessageModel)
            .withView(() => import("./RemoteEmailMessage"));

        // A recipient is a value on a row, never something to open.
        Navigator.getOrAddSettings(RecipientEmbedded).isViewable = "Never";

        // ---- filtering ----------------------------------------------------------------------------------

        // A quick filter on a From/To cell should filter by the ADDRESS, not by the whole embedded.
        Finder.quickFilterRules().push({
            name: "EmailAddress",
            applicable: (qt: QueryToken) => qt.filterType === "Embedded" && qt.type.getTypeName() === RecipientEmbedded.typeName,
            execute: async (qt: QueryToken, value: unknown, sc: SearchControlLoaded) => {
                const token = await sc.parseSingleFilterToken(qt.fullKey() + ".emailAddress");
                return sc.addQuickFilter(token, "EqualTo", (value as RecipientEmbedded | undefined)?.emailAddress);
            },
        });

        Finder.quickFilterRules().push({
            name: "RemoteEmailFolder",
            applicable: (qt: QueryToken) => qt.filterType === "Model" && qt.type.getTypeName() === RemoteEmailFolderModel.typeName,
            execute: (qt: QueryToken, value: unknown, sc: SearchControlLoaded) =>
                Promise.resolve(sc.addQuickFilter(qt, "EqualTo", value)),
        });

        // A folder in a URL / a saved filter is just its id (Signum's server-side RemoteEmailFolderConverter;
        // altea formats and parses filter values client-side). The displayName is filled in once the real
        // folder list arrives — see FolderLine's effect.
        Finder.Encoder.encodeModel[RemoteEmailFolderModel.typeName] =
            (model: RemoteEmailFolderModel) => model.folderId;

        Finder.Decoder.decodeModel[RemoteEmailFolderModel.typeName] = (folderId: unknown) => {
            if (!folderId)
                return null;
            if (typeof folderId === "string")
                return RemoteEmailFolderModel.create({ folderId, displayName: folderId });
            if (folderId instanceof RemoteEmailFolderModel)
                return folderId;
            throw new Error("Unexpected " + String(folderId));
        };

        // The User filter is a real entity picker (no autocomplete over a directory), …
        Finder.filterValueFormatRules().push({
            name: "User",
            applicable: (f: FilterOptionParsed) => isFilterCondition(f) && f.token?.fullKey() === "user" && f.operation === "EqualTo",
            renderValue: (f: FilterOptionParsed, ffc: Finder.FilterFormatterContext) =>
                <EntityLine ctx={ffc.ctx} create={false} label={ffc.label} mandatory={ffc.mandatory}
                    onChange={() => ffc.handleValueChange(f)} />,
        });

        // … and the Folder filter is a <select> over THAT user's folders.
        Finder.filterValueFormatRules().push({
            name: "EmailFolder",
            applicable: (f: FilterOptionParsed) => isFilterCondition(f)
                && f.token?.type.getTypeName() === RemoteEmailFolderModel.typeName,
            renderValue: (f: FilterOptionParsed, ffc: Finder.FilterFormatterContext) =>
                <FolderLine ctx={ffc.ctx} mandatory={ffc.mandatory} label={ffc.label}
                    user={userFilterValue(ffc.filterOptions)}
                    onChange={() => ffc.handleValueChange(f)} />,
        });

        // ---- the search page ----------------------------------------------------------------------------

        Finder.addSettings({
            queryName: RemoteEmailMessageRowModel,
            allowCreate: false,
            markRowsColumn: "messageId",
            // Pinned and ALWAYS active: the query cannot run without a user (see the row model's note).
            defaultFilters: [
                { token: "user", value: AppContext.currentUser, pinned: { active: "Always" } },
            ],
            // Read by the formatters / row actions, not shown.
            hiddenColumns: [
                { token: "user" },
                { token: "messageId" },
                { token: "hasAttachments" },
                { token: "isRead" },
            ],
            onDoubleClick: (_e, row, _columns, sc) => void openMessage(row, sc!),
            entityFormatter: new Finder.EntityFormatter(ctx => (
                <LinkButton title={SearchMessage.View.niceToString()}
                    onClick={() => void openMessage(ctx.row, ctx.searchControl!)}>
                    {EntityBaseController.getViewIcon()}
                </LinkButton>
            )),
            formatters: {
                "subject": new Finder.CellFormatter((val, cfc) => {
                    const hasAttachments = cfc.searchControl?.getRowValue(cfc.row, "hasAttachments")
                        ? <FontAwesomeIcon icon="paperclip" className="me-1" /> : null;
                    const isRead = cfc.searchControl?.getRowValue(cfc.row, "isRead") as boolean;
                    const user = cfc.searchControl?.getRowValue(cfc.row, "user") as Lite<UserEntity>;
                    const messageId = cfc.searchControl?.getRowValue(cfc.row, "messageId") as string;

                    const preview = <RemoteEmailPopover subject={val as string} isRead={isRead}
                        user={user} remoteEmailId={messageId} />;

                    const text = etc((val as string) ?? "", 100);

                    // Unread is BOLD, exactly as a mail client shows it.
                    return isRead
                        ? <span className="try-no-wrap">{preview} {hasAttachments} {text}</span>
                        : <strong className="try-no-wrap">{preview} {hasAttachments} {text}</strong>;
                }, true),
            },
        });

        onContextualItems().push(getMessageContextualItems);
        ButtonBarManager.onButtonBarRender().push(getMessageButtons);
    }

    // ---- the four actions, as buttons on an opened message -----------------------------------------------

    export function getMessageButtons(ctx: ButtonsContext): (ButtonBarElement | undefined)[] | undefined {
        const entity = ctx.pack.entity;
        if (!(entity instanceof RemoteEmailMessageModel))
            return undefined;

        // A separate const, so the narrowed type is what the button callbacks below capture.
        const message: RemoteEmailMessageModel = entity;
        const userId = message.user.id!;

        async function reload(): Promise<void> {
            Operations.notifySuccess();
            const remote = await API.getRemoteEmail(userId, message.id);
            ctx.frame.onReload(await Navigator.toEntityPack(remote));
        }

        return [
            {
                button: <button className={classes("btn", "btn-info")} title={RemoteEmailMessageMessage.Move.niceToString()}
                    onClick={async () => {
                        const folder = await selectFolder(userId);
                        if (folder == null)
                            return;

                        await API.moveEmails(userId, [message.id], folder.folderId);
                        Operations.notifySuccess();
                    }}>
                    <FontAwesomeIcon aria-hidden={true} icon="folder-tree" /> {RemoteEmailMessageMessage.Move.niceToString()}
                </button>,
            },
            {
                button: <button className={classes("btn", "btn-success")} title={RemoteEmailMessageMessage.AddCategory.niceToString()}
                    onClick={async () => {
                        const categories = await API.getRemoteCategories(userId);
                        const category = await SelectorModal.chooseElement(categories,
                            { title: RemoteEmailMessageMessage.AddCategory.niceToString() });

                        if (category == null)
                            return;

                        await API.changeCategories(userId, { messageIds: [message.id], categoriesToAdd: [category], categoriesToRemove: [] });
                        await reload();
                    }}>
                    <FontAwesomeIcon aria-hidden={true} icon="tags" /> {RemoteEmailMessageMessage.AddCategory.niceToString()}
                </button>,
            },
            {
                button: <button className={classes("btn", "btn-warning")} title={RemoteEmailMessageMessage.RemoveCategory.niceToString()}
                    onClick={async () => {
                        // Only the categories this message actually has — `forceShow` so a single one still asks.
                        const category = await SelectorModal.chooseElement(message.categories,
                            { title: RemoteEmailMessageMessage.RemoveCategory.niceToString(), forceShow: true });

                        if (category == null)
                            return;

                        await API.changeCategories(userId, { messageIds: [message.id], categoriesToAdd: [], categoriesToRemove: [category] });
                        await reload();
                    }}>
                    <FontAwesomeIcon aria-hidden={true} icon="tags" /> {RemoteEmailMessageMessage.RemoveCategory.niceToString()}
                </button>,
            },
            {
                button: <button className={classes("btn", "btn-danger")} title={RemoteEmailMessageMessage.Delete.niceToString()}
                    onClick={async () => {
                        if (!await confirmDelete(1))
                            return;

                        await API.deleteEmails(userId, [message.id]);
                        Operations.notifySuccess();
                        ctx.frame.onClose(undefined);
                    }}>
                    <FontAwesomeIcon aria-hidden={true} icon="trash" /> {RemoteEmailMessageMessage.Delete.niceToString()}
                </button>,
            },
        ];
    }

    // ---- the same four, over the selected rows -----------------------------------------------------------

    export async function getMessageContextualItems(ctx: ContextualItemsContext<Entity>): Promise<MenuItemBlock | undefined> {
        if (queryKeyOf(ctx.queryToken.queryName) !== getQueryKey(RemoteEmailMessageRowModel))
            return undefined;

        if (!(ctx.container instanceof SearchControlLoaded))
            return undefined;

        const sc = ctx.container;

        const messageIds = (sc.state.selectedRows ?? [])
            .map(r => sc.getRowValue<string>(r, "messageId"))
            .filter((id): id is string => id != null);

        if (messageIds.length === 0)
            return undefined;

        const user = userFilterValue(sc.state.resultFindOptions?.filterOptions ?? []);

        if (user == null)
            throw new Error(RemoteEmailMessageMessage.UserFilterNotFound.niceToString());

        const userId = user.id!;

        return {
            header: RemoteEmailMessageMessage.Messages.niceToString(),
            menuItems: [
                <Dropdown.Item key="move" onClick={async () => {
                    const folder = await selectFolder(userId);
                    if (folder == null)
                        return;

                    sc.markRows((await API.moveEmails(userId, messageIds, folder.folderId)).errors);
                }}>
                    <FontAwesomeIcon aria-hidden={true} icon="folder-tree" className="icon" color="blue" />
                    {RemoteEmailMessageMessage.Move.niceToString()}
                </Dropdown.Item>,

                <Dropdown.Item key="addCategory" onClick={async () => {
                    const categories = await API.getRemoteCategories(userId);
                    const category = await SelectorModal.chooseElement(categories,
                        { title: RemoteEmailMessageMessage.AddCategory.niceToString() });

                    if (category == null)
                        return;

                    sc.markRows((await API.changeCategories(userId,
                        { messageIds, categoriesToAdd: [category], categoriesToRemove: [] })).errors);
                }}>
                    <FontAwesomeIcon aria-hidden={true} icon="tag" className="icon" color="green" />
                    {RemoteEmailMessageMessage.AddCategory.niceToString()}
                </Dropdown.Item>,

                <Dropdown.Item key="removeCategory" onClick={async () => {
                    const categories = await API.getRemoteCategories(userId);
                    const category = await SelectorModal.chooseElement(categories,
                        { title: RemoteEmailMessageMessage.RemoveCategory.niceToString() });

                    if (category == null)
                        return;

                    sc.markRows((await API.changeCategories(userId,
                        { messageIds, categoriesToAdd: [], categoriesToRemove: [category] })).errors);
                }}>
                    <FontAwesomeIcon aria-hidden={true} icon="tag" className="icon" color="orange" />
                    {RemoteEmailMessageMessage.RemoveCategory.niceToString()}
                </Dropdown.Item>,

                <Dropdown.Item key="delete" onClick={async () => {
                    if (!await confirmDelete(messageIds.length))
                        return;

                    sc.markRows((await API.deleteEmails(userId, messageIds)).errors);
                }}>
                    <FontAwesomeIcon aria-hidden={true} icon="trash" className="icon" color="red" />
                    {RemoteEmailMessageMessage.Delete.niceToString()}
                </Dropdown.Item>,
            ],
        };
    }

    // ---- helpers ----------------------------------------------------------------------------------------

    function confirmDelete(numberOfMessages: number): Promise<boolean> {
        return MessageModal.show({
            title: RemoteEmailMessageMessage.Delete.niceToString(),
            message: RemoteEmailMessageMessage.PleaseConfirmYouWouldLikeToDelete0FromOutlook.niceToString()
                .formatHtml(<span>
                    <strong>{numberOfMessages}</strong>{" "}
                    {numberOfMessages === 1
                        ? RemoteEmailMessageMessage.Message.niceToString()
                        : RemoteEmailMessageMessage.Messages.niceToString()}
                </span>),
            buttons: "yes_no",
            icon: "warning",
            style: "warning",
        }).then(result => result === "yes");
    }

    async function selectFolder(userId: string | number): Promise<RemoteEmailFolderModel | undefined> {
        const folders = await API.getRemoteFolders(userId);

        return await SelectorModal.chooseElement(folders, {
            title: RemoteEmailMessageMessage.Move.niceToString(),
            message: RemoteEmailMessageMessage.SelectAFolder.niceToString(),
            buttonDisplay: a => a.displayName,
        });
    }

    async function openMessage(row: ResultRow, sc: SearchControlLoaded): Promise<void> {
        const user = sc.getRowValue<Lite<UserEntity>>(row, "user");
        const messageId = sc.getRowValue<string>(row, "messageId");

        if (user == null || messageId == null)
            throw new Error("The row carries no user / message id — are the `user` and `messageId` columns present?");

        await Navigator.view(await API.getRemoteEmail(user.id!, messageId));

        // The message may have been moved / deleted / re-categorised while open.
        sc.doSearchPage1();
    }

    export namespace API {

        export function getRemoteEmail(userId: string | number, messageId: string): Promise<RemoteEmailMessageModel> {
            return ajaxGet({ url: `/api/remoteEmail/${userId}/message/${messageId}` });
        }

        export function getRemoteFolders(userId: string | number): Promise<RemoteEmailFolderModel[]> {
            return ajaxGet({ url: `/api/remoteEmailFolders/${userId}` });
        }

        export function getRemoteCategories(userId: string | number): Promise<string[]> {
            return ajaxGet({ url: `/api/remoteEmailCategories/${userId}` });
        }

        export function getRemoteAttachment(userId: string | number, messageId: string, attachmentId: string): Promise<Response> {
            return ajaxGetRaw({ url: `/api/remoteEmail/${userId}/message/${messageId}/attachment/${attachmentId}` });
        }

        export function deleteEmails(userId: string | number, messageIds: string[]): Promise<Operations.API.ErrorReport> {
            const abortController = new AbortController();
            return MultiMessageProgressModal.show(messageIds, RemoteEmailMessageMessage.Deleting.niceToString(), abortController,
                () => ajaxPostRaw({ url: `/api/remoteEmail/${userId}/delete`, signal: abortController.signal }, messageIds));
        }

        export function moveEmails(userId: string | number, messageIds: string[], folderId: string): Promise<Operations.API.ErrorReport> {
            const abortController = new AbortController();
            return MultiMessageProgressModal.show(messageIds, RemoteEmailMessageMessage.Moving.niceToString(), abortController,
                () => ajaxPostRaw({ url: `/api/remoteEmail/${userId}/moveTo/${folderId}`, signal: abortController.signal }, messageIds));
        }

        export function changeCategories(userId: string | number, request: ChangeCategoriesRequest): Promise<Operations.API.ErrorReport> {
            const abortController = new AbortController();
            return MultiMessageProgressModal.show(request.messageIds, RemoteEmailMessageMessage.ChangingCategories.niceToString(), abortController,
                () => ajaxPostRaw({ url: `/api/remoteEmail/${userId}/changeCategories`, signal: abortController.signal }, request));
        }
    }
}

/** Signum's RemoteEmailController.ChangeCategoriesRequest, as the client sends it. */
export interface ChangeCategoriesRequest {
    messageIds: string[];
    categoriesToAdd: string[];
    categoriesToRemove: string[];
}

/** One line of the bulk actions' NDJSON response (Signum's EmailResult). */
export interface EmailResult {
    id: string;
    error?: string;
}

/**
 * The `user` EqualTo condition's value among a set of parsed filters — the mailbox the page is showing.
 * Written as a loop rather than `.find(f => isFilterCondition(f) && … f.operation === "EqualTo")` because the
 * type guard does not narrow inside a `find` callback (isFilterCondition is overloaded, so TS resolves it
 * against the wrong overload there and `operation` stays off the union).
 */
function userFilterValue(filters: FilterOptionParsed[]): Lite<UserEntity> | undefined {
    for (const f of filters)
        if (isFilterCondition(f) && f.token?.fullKey() === "user" && f.operation === "EqualTo")
            return f.value as Lite<UserEntity>;

    return undefined;
}

/** Signum's `string.etc(n)`. */
function etc(value: string, max: number): string {
    return value.length <= max ? value : value.substring(0, max - 3) + "...";
}
