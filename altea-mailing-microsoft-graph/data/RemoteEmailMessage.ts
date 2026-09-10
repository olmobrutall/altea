import { reflect } from "@altea/altea/data/reflection";
import { EmbeddedEntity, ModelEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { niceName } from "@altea/altea/data/decorators";
import { Temporal, type long } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import { toComputerSize } from "@altea/altea-files/data/Files";
import { UserEntity } from "@altea/altea-auth/data/User";

// The shapes behind "browse a user's actual Outlook mailbox from inside the app". Nothing here is stored:
// the search page and the message view are backed by live Microsoft Graph calls (see
// server/RemoteEmailsLogic.ts).
//
// **TWO model types, not one.** A query's NAME is its row model, so `RemoteEmailMessageRowModel` is the
// query and `RemoteEmailMessageModel` is the opened message — and decisively, **a query row model must not
// have a member called `id`**, because a member of that name is excluded from the token tree. The message
// view keeps `id`, since it is never a query row.
//
// Port of Signum.Mailing.MicrosoftGraph/RemoteEmails' RemoteEmailMessage.cs — see
// docs/port/MailingMicrosoftGraph.md.

/** One mailbox on a remote message. */
@reflect
export class RecipientEmbedded extends EmbeddedEntity {

    emailAddress: string | null = null;

    name: string | null = null;

    override toString(): string {
        return `${this.name ?? ""} <${etc(this.emailAddress ?? "", 35)}>`;
    }
}

/** A mail folder, identified by its Graph folder id. */
@reflect
export class RemoteEmailFolderModel extends ModelEntity {

    folderId: string = "";

    displayName: string = "";

    override toString(): string {
        return this.displayName;
    }
}

/** One attachment on a remote message (metadata only; the bytes are
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
        return `${this.name} ${toComputerSize(this.size)}`;
    }
}

/**
 * The ROW of the remote-mailbox query (see the header for why this is separate from the message model).
 * `entity` is always null — there is no local entity behind an Outlook message — and exists because the
 * SearchControl expects an entity column.
 */
@reflect
export class RemoteEmailMessageRowModel extends ModelEntity {

    /** Always null: the column exists so the SearchControl has an entity to render, not to carry a row. */
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

    /** A DISPLAY string: the recipients joined with ", ". */
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

    /** The message's Outlook categories, joined with ", " — a DISPLAY column. The list
     *  itself; a query row cannot hold a collection in altea (no table, so no `@part` row to hang it on),
     *  and the opened message model below carries the real array. */
    categories: string | null = null;

    /**
     * WHOSE mailbox to read. A required filter, not a result column: the query throws without it (the
     * `RemoteEmailMessageMessage.UserFilterNotFound`), because "every user's inbox" is not a thing Graph — or
     * this feature — offers.
     */
    user: Lite<UserEntity> | null = null;

    /** App-defined single-value extended properties (see the converter's
     *  `getExpansionPropertyId`, which returns null until an app overrides it). */
    extension0: string | null = null;
    extension1: string | null = null;
    extension2: string | null = null;
    extension3: string | null = null;

    override toString(): string {
        return this.subject ?? "";
    }
}

/** ONE opened remote message. */
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

/** Truncate with an ellipsis. Local because this is the only user in the module. */
function etc(value: string, max: number): string {
    return value.length <= max ? value : value.substring(0, max - 3) + "...";
}
