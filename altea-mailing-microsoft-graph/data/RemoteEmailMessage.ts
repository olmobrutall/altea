import { reflect } from "@altea/altea/data/reflection";
import { EmbeddedEntity, ModelEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { niceName } from "@altea/altea/data/decorators";
import { Temporal, type long } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import { toComputerSize } from "@altea/altea-files/data/Files";
import { UserEntity } from "@altea/altea-auth/data/User";

// Port of Signum.Mailing.MicrosoftGraph/RemoteEmails' RemoteEmailMessage.cs — the shapes behind "browse a
// user's actual Outlook mailbox from inside the app". Nothing here is stored: the search page and the message
// view are backed by live Microsoft Graph calls (see server/RemoteEmailsLogic.ts).
//
// altea divergences, documented inline:
//  - Signum names the manual query with an enum member (`RemoteEmailMessageQuery.RemoteEmailMessages`) and
//    describes its columns with an anonymous projection. altea has no QueryDescription: a query's NAME is its
//    row model, so the row shape is `RemoteEmailMessageRowModel` below and each column's caption is the
//    field's own `@niceName` — the same treatment altea-auth-azuread's ActiveDirectoryUserModel gets.
//  - Signum's ONE `RemoteEmailMessageModel` serves both roles: the query row AND the opened message. They
//    carry different fields (a row has a `toRecipients` STRING and no body; the opened message has the full
//    recipient lists, the body and the attachments), and — decisively — a query row model must not have a
//    member called `id`, because a member of that name is excluded from the token tree. So the two roles are
//    two types: `RemoteEmailMessageRowModel` (the query) and `RemoteEmailMessageModel` (the message view,
//    which keeps `id` because it is never a query row).
//  - `PreSaving` / `PostRetrieving` throwing "RemoteEmails can not be saved" has no altea counterpart on a
//    ModelEntity (altea models are not saved or retrieved through the ORM at all — there is no table).
//  - `DateTimeOffset` becomes `Temporal.PlainDateTime` (altea's date/time family, per CLAUDE.md). Graph
//    returns UTC ISO strings, which the server converts once.
//  - `MList<string> Categories` becomes a plain `string[]`: this is a MODEL, so there is no table and no
//    `@part` row to hang the elements on.

/** Signum's RecipientEmbedded — one mailbox on a remote message. */
@reflect
export class RecipientEmbedded extends EmbeddedEntity {

    emailAddress: string | null = null;

    name: string | null = null;

    override toString(): string {
        return `${this.name ?? ""} <${etc(this.emailAddress ?? "", 35)}>`;
    }
}

/** Signum's RemoteEmailFolderModel — a mail folder, identified by its Graph folder id. */
@reflect
export class RemoteEmailFolderModel extends ModelEntity {

    folderId: string = "";

    displayName: string = "";

    override toString(): string {
        return this.displayName;
    }
}

/** Signum's RemoteAttachmentEmbedded — one attachment on a remote message (metadata only; the bytes are
 *  fetched on demand through the download route). */
@reflect
export class RemoteAttachmentEmbedded extends EmbeddedEntity {

    id: string = "";

    name: string = "";

    size: long;

    lastModifiedDateTime: Temporal.PlainDateTime;

    isInline: boolean = false;

    contentId: string | null = null;

    override toString(): string {
        return `${this.name} ${toComputerSize(this.size as unknown as number)}`;
    }
}

/**
 * The ROW of the remote-mailbox query (see the header for why this is separate from the message model).
 * `entity` is always null — there is no local entity behind an Outlook message — and exists because the
 * SearchControl expects an entity column, exactly as in Signum's projection.
 */
@reflect
export class RemoteEmailMessageRowModel extends ModelEntity {

    /** Always null — Signum marks its own projection of this column with the comment "Lie". */
    entity: Lite<UserEntity> | null = null;

    /**
     * The Graph message id. NOT called `id`: a member of that name is EXCLUDED from a query's token tree
     * (QueryToken.entityProperties skips it), so it would be unreachable as a column — and this one has to be
     * a column, because every row action (open / move / delete / categorise) is addressed by it.
     */
    @niceName("Id")
    messageId: string | null = null;

    subject: string | null = null;

    from: RecipientEmbedded | null = null;

    /** A DISPLAY string, as in Signum: the recipients joined with ", ". */
    @niceName("To")
    toRecipients: string | null = null;

    createdDateTime: Temporal.PlainDateTime | null = null;
    receivedDateTime: Temporal.PlainDateTime | null = null;
    sentDateTime: Temporal.PlainDateTime | null = null;
    lastModifiedDateTime: Temporal.PlainDateTime | null = null;

    isRead: boolean | null = null;
    isDraft: boolean | null = null;
    hasAttachments: boolean | null = null;

    folder: RemoteEmailFolderModel | null = null;

    /** The message's Outlook categories, joined with ", " — a DISPLAY column. Signum projects the list
     *  itself; a query row cannot hold a collection in altea (no table, so no `@part` row to hang it on),
     *  and the opened message model below carries the real array. */
    categories: string | null = null;

    /**
     * WHOSE mailbox to read. A required filter, not a result column: the query throws without it (Signum's
     * `RemoteEmailMessageMessage.UserFilterNotFound`), because "every user's inbox" is not a thing Graph — or
     * this feature — offers.
     */
    user: Lite<UserEntity> | null = null;

    /** Signum's Extension0..3 — app-defined single-value extended properties (see the converter's
     *  `getExpansionPropertyId`, which returns null until an app overrides it). */
    extension0: string | null = null;
    extension1: string | null = null;
    extension2: string | null = null;
    extension3: string | null = null;

    override toString(): string {
        return this.subject ?? "";
    }
}

/** Signum's RemoteEmailMessageModel — ONE opened remote message. */
@reflect
export class RemoteEmailMessageModel extends ModelEntity {

    /** The Graph message id. Safe to call `id` here: this model is never a query row (see the header). */
    id: string = "";

    user: Lite<UserEntity>;

    subject: string = "";

    body: string = "";
    isBodyHtml: boolean = false;
    isDraft: boolean = false;
    isRead: boolean = false;
    hasAttachments: boolean = false;

    from: RecipientEmbedded | null = null;
    toRecipients: RecipientEmbedded[] = [];
    ccRecipients: RecipientEmbedded[] = [];
    bccRecipients: RecipientEmbedded[] = [];

    attachments: RemoteAttachmentEmbedded[] = [];

    folder: RemoteEmailFolderModel | null = null;
    categories: string[] = [];

    createdDateTime: Temporal.PlainDateTime | null = null;
    lastModifiedDateTime: Temporal.PlainDateTime | null = null;
    receivedDateTime: Temporal.PlainDateTime | null = null;
    sentDateTime: Temporal.PlainDateTime | null = null;

    /** The `https://outlook.office365.com/...` deep link Graph hands out. */
    webLink: string | null = null;

    extension0: string | null = null;
    extension1: string | null = null;
    extension2: string | null = null;
    extension3: string | null = null;

    override toString(): string {
        return this.subject;
    }
}

// Signum's RemoteEmailMessageMessage.
export const RemoteEmailMessageMessage = {
    UserFilterNotFound: msg("User filter not found"),
    User0HasNoMailbox: msg("User {0} has not mailbox"),
    Deleting: msg(),
    Delete: msg(),
    Moving: msg(),
    Move: msg(),
    AddCategory: msg("Add category"),
    RemoveCategory: msg("Remove category"),
    ChangingCategories: msg("Changing categories"),
    Messages: msg(),
    Message: msg(),
    SelectAFolder: msg("Select a folder"),
    PleaseConfirmYouWouldLikeToDelete0FromOutlook: msg("Please confirm you would like to delete {0} from Outlook"),
};

/** Signum's `string.Etc(n)` — truncate with an ellipsis. Local because this is the only user in the module. */
function etc(value: string, max: number): string {
    return value.length <= max ? value : value.substring(0, max - 3) + "...";
}
