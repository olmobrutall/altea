import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity, MixinEntity, type Type } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import {
    entity, implementedBy, uniqueIndex, backReference, format, unit, quoted,
    stringLengthValidator,
} from "@altea/altea/data/decorators";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { Temporal, type int, toInt } from "@altea/altea/data/basics";
import { BigStringEmbedded } from "@altea/altea/data/bigString";
import { ExceptionEntity } from "@altea/altea/data/exception";
import type { ExecuteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import type { ITaskEntity } from "@altea/altea-scheduler/data/Scheduler";
import { SimpleTaskSymbol } from "@altea/altea-scheduler/data/Scheduler";
import { EmailMessageEntity } from "./EmailMessage";

// Port of Signum.Mailing/Reception's EmailReceptionConfigurationEntity.cs + EmailReceptionMixin.cs — the
// INBOUND half of the mail module: which mailboxes are polled, what each poll produced, and the extra
// information a RECEIVED EmailMessage carries (its server UID, its raw MIME, when it was sent / received /
// deleted from the server).
//
// The protocol itself is not here: `EmailReceptionServiceEntity` is the abstract "how do we fetch" the way
// `EmailServiceEntity` is the abstract "how do we send", and a concrete service lives in its own package
// (@altea/altea-mailing-pop3), exactly as in Signum.
//
// altea divergences, documented inline:
//  - `MList<ClientCertificationFileEmbedded>` on the POP3 service becomes that owner's `@part` row, in the
//    POP3 package (the same treatment SmtpNetworkDeliveryEmbedded already gets).
//  - Signum declares `EmailReceptionConfigurationOperation.ReceiveLastEmails` and never registers it (no
//    caller anywhere in Signum or Southwind); it is NOT ported, rather than seeding a symbol row for an
//    operation that can never run.
//  - `[DbType(DateTimeKind = DateTimeKind.Utc)]` on SentDate has no altea counterpart: altea's
//    Temporal.PlainDateTime is kind-less, so the POP3 client converts to UTC before storing (see its
//    `toEmailMessage`) rather than the column declaring it.
//  - `BindParent` (Signum's parent back-pointer on an embedded) has no altea counterpart and needs none —
//    validation and the save cascade reach an embedded through its owner.
//  - `EmailReceptionConfigurationEntity` gets a `toString()` (Signum leaves the default `Type(id)`): the
//    configuration is referenced by every reception row and shown in every lookup, and its e-mail address is
//    the only thing that identifies it to a reader.

// Signum's CompareInbox — how much of the mailbox a poll compares against what is already stored.
export enum CompareInboxEnum {
    /** Ask the server for every UID and skip the ones already received. Correct, but O(mailbox). */
    Full,
    /** Only look past the newest N already-received messages (see Pop3ConfigurationLogic's
     *  maxReceptionPerTime). Cheap, and enough for a mailbox that is drained regularly. */
    LastNEmails,
}

// Signum's EmailReceptionServiceEntity — the abstract "fetching mechanism" a configuration points at.
@reflect
@entity("Part", "Master")
export abstract class EmailReceptionServiceEntity extends Entity {
}

// Signum's EmailReceptionConfigurationEntity.
@reflect
@entity("Shared", "Master")
export class EmailReceptionConfigurationEntity extends Entity implements ITaskEntity {

    active: boolean;

    @stringLengthValidator({ max: 100 })
    emailAddress: string;

    /** Once a received message is this many days old, the copy on the SERVER is deleted (never the local
     *  one). Null keeps the server copy forever. */
    @unit("d")
    deleteMessagesAfter: int | null = toInt(14);

    compareInbox: CompareInboxEnum;

    // Signum's `[ImplementedBy()]` — deliberately EMPTY: altea-email ships no reception service of its own,
    // so the app widens this with `overrideImplementedBy(EmailReceptionConfigurationEntity, "service", …)`
    // once it has wired a protocol package in (Signum's `AssertImplementedBy` from Pop3ConfigurationLogic).
    @implementedBy(() => [])
    service: EmailReceptionServiceEntity;

    @quoted
    toString(): string {
        return this.emailAddress;
    }
}

export namespace EmailReceptionConfigurationOperation {
    export const Save: ExecuteSymbol<EmailReceptionConfigurationEntity> = init();
    /** Poll this mailbox NOW, in the caller's request (Signum's ConstructFrom). */
    export const ReceiveEmails: ConstructSymbol<EmailReceptionEntity, From<EmailReceptionConfigurationEntity>> = init();
}

export namespace EmailReceptionAction {
    /** The scheduled task that polls every ACTIVE configuration (Signum's SimpleTaskSymbol). */
    export const ReceiveAllActiveEmailConfigurations: SimpleTaskSymbol = init();
}

// Signum's EmailReceptionEntity — one poll of one mailbox: when it ran, how much it found, what broke.
@reflect
@entity("System", "Transactional")
export class EmailReceptionEntity extends Entity {

    emailReceptionConfiguration: Lite<EmailReceptionConfigurationEntity>;

    @format("G")
    startDate: Temporal.PlainDateTime;

    @format("G")
    endDate: Temporal.PlainDateTime | null;

    /** How many messages this poll actually stored. */
    newEmails: int;

    /** How many messages the server reported in the mailbox. */
    serverEmails: int;

    @stringLengthValidator({ max: 100 })
    lastServerMessageUID: string | null;

    /** Signum's MailsFromDifferentAccounts — set when a message arrived that this account is not a
     *  recipient of AND that was already received before, which means the mailbox is being fed from
     *  somewhere unexpected. Worth surfacing rather than silently de-duplicating. */
    mailsFromDifferentAccounts: boolean;

    exception: Lite<ExceptionEntity> | null;
}

// Signum's EmailReceptionExceptionEntity — one message that failed to be stored, so ONE bad message does not
// lose the whole poll (the reception row itself stays successful).
@reflect
@entity("System", "Transactional")
export class EmailReceptionExceptionEntity extends Entity {

    reception: Lite<EmailReceptionEntity>;

    exception: Lite<ExceptionEntity>;
}

// Signum's EmailReceptionInfoEmbedded — what a RECEIVED message carries beyond an ordinary one.
@reflect
export class EmailReceptionInfoEmbedded extends EmbeddedEntity {

    /** The server's UID for this message: the de-duplication key across polls, hence the unique index. */
    @uniqueIndex
    @stringLengthValidator({ min: 1, max: 100 })
    uniqueId: string;

    reception: Lite<EmailReceptionEntity>;

    /** The whole original MIME message. Unbounded, so a BigStringEmbedded. */
    rawContent: BigStringEmbedded = new BigStringEmbedded();

    /** When the SENDER sent it (from the message's own Date header), in UTC — see the header note. */
    @format("G")
    sentDate: Temporal.PlainDateTime;

    /** When WE fetched it. */
    @format("G")
    receivedDate: Temporal.PlainDateTime;

    /** When the copy on the SERVER was deleted (see EmailReceptionConfiguration.deleteMessagesAfter). */
    @format("G")
    deletionDate: Temporal.PlainDateTime | null;
}

// Signum's EmailReceptionMixin — hangs the reception info off EmailMessageEntity, so a received message is
// an ordinary EmailMessage plus this, and nothing on the sending side has to know reception exists.
@reflect
export class EmailReceptionMixin extends MixinEntity {
    receptionInfo: EmailReceptionInfoEmbedded | null = null;
}

export namespace EmailReceptionMixin {
    let declared = false;

    /** Declare the mixin on EmailMessageEntity (Signum's `MixinDeclarations.Register<EmailMessageEntity,
     *  EmailReceptionMixin>()`, asserted by EmailReceptionLogic.start). Idempotent, and must run on BOTH
     *  TIERS before anything is (de)serialized or the schema is built — so an app calls it from its shared
     *  entity-overrides module, next to the `overrideImplementedBy` for `service`. */
    export function declare(): void {
        if (declared)
            return;
        declared = true;

        MixinDeclarations.register(
            EmailMessageEntity as unknown as Type<EmailMessageEntity>,
            EmailReceptionMixin as unknown as Type<EmailReceptionMixin>);
    }

    export function isDeclared(): boolean {
        return declared;
    }
}
