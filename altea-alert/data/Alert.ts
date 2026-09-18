import { reflect, init, setDefaultDatabaseSchema, registerEnum } from "@altea/altea/data/reflection";
import { Entity, ModelEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { SemiSymbol } from "@altea/altea/data/semiSymbol";
import {
    entity, part, implementedByAll, quoted, column, unit, valueField, backReference, rowOrder, legacyPropertyRoute,
} from "@altea/altea/data/decorators";
import {
    stringLengthValidator, validate, noRepeatValidator, notNullValidator, ValidationMessage,
} from "@altea/altea/data/validators";
import { Temporal, type int, toInt } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { msg } from "@altea/altea/data/utils/localization";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From, Simple } from "@altea/altea/data/operations";
import type { IQuery } from "@altea/altea/data/iquery";
import type { IUserEntity } from "@altea/altea/data/security";
import { UserEntity } from "@altea/altea-auth/data/User";
import { Enum } from "@altea/altea/data/enum";

// Port of Signum.Alerts' Alert.cs + SendNotificationEmailTaskEntity.cs — a NOTIFICATION addressed to a user
// about an entity: when it should surface (`alertDate`), who has dealt with it (`attendedDate` / `attendedBy`)
// and what it says (a free `textField`, or the text registered for its `alertType`).
//
// altea divergences (all forced, all documented where they bite):
//
//  - **AlertTypeSymbol is a plain Symbol, not a SemiSymbol.** altea has no SemiSymbol (the same divergence
//    altea-agent's AgentSymbol records), so an alert type is DECLARED IN CODE and registered with
//    `AlertLogic.registerAlertType` — a user cannot invent one from the UI. That drops Signum's `Name`
//    field, its Save/Delete operations and its AlertType view along with it.
//  - **`Title` / `Text` are NOT expressions.** Signum declares them `[AutoExpressionField]` and then
//    REPLACES them in the logic layer (`As.ReplaceExpression`) with bodies that call `AlertType.GetText()` —
//    a C# delegate off a dictionary, which no SQL can evaluate. altea has neither ReplaceExpression nor a
//    way to lower that call, so the STORED `titleField` / `textField` are what a query sees, and the
//    alert-type fallback happens where the registry actually lives: on the server when the row is retrieved
//    (`textFromAlertType`, exactly as Signum's Retrieved event fills it) and on the client for the title
//    (`AlertsClient.getTitle`).
//  - **`CurrentState` is in-memory**, not a query column: it returns an ENUM from a ternary, which altea's
//    LINQ provider does not lower. The three BOOLEAN faces of it (`alerted` / `attended` / `future`) ARE
//    @quoted expressions, so filtering "what is alerted right now" still happens in SQL — and that is what
//    the alert endpoints and the dropdown use.
//  - a date comparison is written `Temporal.PlainDateTime.compare(a, b) <op> 0` (Temporal has no relational
//    operators — see CLAUDE.md), which is also the form the provider translates.

@reflect
@entity("Main", "Transactional")
export class AlertEntity extends Entity {

    /** The entity this alert is ABOUT. @implementedByAll — an alert can hang off anything. */
    @implementedByAll
    target: Lite<Entity> | null;

    /** Signum's TargetToString: the target's text AS IT WAS, so a deleted target still reads sensibly. */
    @stringLengthValidator({ max: 200 })
    targetToString: string | null;

    /** Where "see it" should navigate, when that is not the target itself. */
    @implementedByAll
    linkTarget: Lite<Entity> | null;

    /** What the dropdown GROUPS this alert under (Signum's AlertDropDownGroup). */
    @implementedByAll
    groupTarget: Lite<Entity> | null;

    creationDate: Temporal.PlainDateTime = Clock.now;

    /** Signum's `[NotNullValidator] DateTime? AlertDate` — REQUIRED but not NOT NULL: the value is
     *  validated, while the column stays nullable so an alert can be built before its date is chosen. */
    @notNullValidator()
    alertDate: Temporal.PlainDateTime | null = null;

    attendedDate: Temporal.PlainDateTime | null;

    /** Signum's TitleField. Mandatory only when there is no `alertType` to take a title from. */
    @validate<AlertEntity>(a =>
        a.titleField == null && a.alertType == null
            ? ValidationMessage._0IsNotSet.niceToString(AlertEntity.nicePropertyName(x => x.titleField))
            : null)
    @stringLengthValidator({ max: 100 })
    titleField: string | null;

    /** Signum's TextArguments — the `{0}` / `{1}` values `textField`'s placeholders resolve against, joined
     *  by the `\n###\n` separator Signum uses. */
    @stringLengthValidator({ multiLine: true })
    textArguments: string | null;

    @stringLengthValidator({ min: 1, multiLine: true })
    textField: string | null;

    /** Signum's `[Ignore] TextFromAlertType` — filled from the registry when the row is retrieved, never a
     *  column (@column(false) is altea's [Ignore]). */
    @column(false)
    textFromAlertType: string | null;

    createdBy: Lite<UserEntity> | null;

    recipient: Lite<UserEntity> | null;

    attendedBy: Lite<UserEntity> | null;

    alertType: AlertTypeSymbol | null;

    state: AlertState = AlertState.New;

    emailNotificationsSent: boolean = false;

    avoidSendMail: boolean = false;

    /** Signum's `Attended => AttendedDate.HasValue`. */
    @legacyPropertyRoute
    @quoted attended(): boolean { return this.attendedDate != null; }

    /** Signum's `NotAttended`. */
    @legacyPropertyRoute
    @quoted notAttended(): boolean { return this.attendedDate == null; }

    /** Signum's `Alerted => !AttendedDate.HasValue && AlertDate <= Clock.Now` — the "show it now" predicate
     *  the alert endpoints filter by, so it has to translate to SQL. */
    @legacyPropertyRoute
    @quoted alerted(): boolean {
        return this.attendedDate == null && Temporal.PlainDateTime.compare(this.alertDate!, Clock.now) <= 0;
    }

    /** Signum's `Future`. */
    @legacyPropertyRoute
    @quoted future(): boolean {
        return this.attendedDate == null && Temporal.PlainDateTime.compare(this.alertDate!, Clock.now) > 0;
    }

    /** Signum's `CurrentState`. */
    @legacyPropertyRoute
    @quoted currentState(): AlertCurrentState {
        return this.attendedDate != null ? AlertCurrentState.Attended :
            Temporal.PlainDateTime.compare(this.alertDate!, Clock.now) <= 0 ? AlertCurrentState.Alerted :
                AlertCurrentState.Future;
    }

    /** Signum's `ToString() => Title`; the alert-type fallback is the client's (see the header). */
    @quoted toString(): string { return this.titleField ?? ""; }
}

export enum AlertState {
    /** Never stored — an alert being created. Signum marks it `[Ignore]`; the `markAsNotMapped` below is
     *  altea's spelling of the same thing. */
    New,
    Saved,
    Attended,
}
Enum.markAsNotMapped(AlertState, AlertState.New);

export enum AlertCurrentState {
    Attended,
    Alerted,
    Future,
}
// What `currentState()` RETURNS, so the registered expression is an enum token rather than a number one:
// the constant fold reads the ordinal off this object, and only a REGISTERED enum can hand its type back
// (see foldOrProperty / enumMemberType in server/linq/expressions). Registering it is also what makes its
// members translatable; no field references it, so nothing else would.
registerEnum(AlertCurrentState);

export namespace AlertOperation {
    /** Owned by the SOURCE type — every entity can spawn an alert (see CLAUDE.md on ConstructFrom). */
    export const CreateAlertFromEntity: ConstructSymbol<AlertEntity, From<Entity>> = init();
    export const Create: ConstructSymbol<AlertEntity, Simple> = init();
    export const Save: ExecuteSymbol<AlertEntity> = init();
    export const Delay: ExecuteSymbol<AlertEntity> = init();
    export const Attend: ExecuteSymbol<AlertEntity> = init();
    export const Unattend: ExecuteSymbol<AlertEntity> = init();
}

/** Signum's DelayOption — the choices the Delay operation offers before asking for a custom date. */
export enum DelayOption {
    _5Mins,
    _15Mins,
    _30Mins,
    _1Hour,
    _2Hours,
    _1Day,
    Custom,
}
// SHOWN to the user — `AlertsClient` builds the Delay chooser with `Enum.niceName(DelayOption, v)`. No
// entity field references it, so the quote-transformer emits no registration of its own, and an
// unregistered enum has no registered NAME: `Enum.niceName` cannot look a translation up and every
// culture falls back to the humanised member ("5 Mins"). Registering it is what makes the enum
// translatable — it creates no table (the schema builder only does that for a field that references it),
// exactly as `dynamicQueries.ts` registers the query-vocabulary enums.
registerEnum(DelayOption);

/**
 * Signum's AlertTypeSymbol (a SemiSymbol there — see the header): "what KIND of alert this is". A module
 * declares its own and registers the text it stands for:
 *
 *     export namespace MyAlertType { export const OrderDelayed: AlertTypeSymbol = init(); }
 *     AlertLogic.registerAlertType(MyAlertType.OrderDelayed, () => MyMessage.OrderIsDelayed.niceToString());
 */
@reflect
@entity("String", "Master", { lowPopulation: true })
export class AlertTypeSymbol extends SemiSymbol { }

/** Signum's AlertTypeOperation — a SemiSymbol table is user-writable, so its rows are edited. */
export namespace AlertTypeOperation {
    export const Save: ExecuteSymbol<AlertTypeSymbol> = init();
    export const Delete: DeleteSymbol<AlertTypeSymbol> = init();
}

/** Signum's AlertDropDownGroup — how the navbar dropdown groups what it shows. */
export enum AlertDropDownGroup {
    ByType,
    ByUser,
    ByTypeAndUser,
}

// ---- The "send pending alerts by e-mail" scheduled task -------------------------------------------------

// Signum's SendNotificationEmailTaskEntity: a ScheduledTask that mails every user their unattended alerts.
// The app widens `ScheduledTaskEntity.task` to include it (altea's AssertImplementedBy, checked in
// AlertLogic.registerAlertNotificationMail).
@reflect
@entity("Shared", "Master")
export class SendNotificationEmailTaskEntity extends Entity {

    /** Only alerts whose `alertDate` is at least this old are mailed (so a burst is batched). */
    @unit("mins")
    sendNotificationsOlderThan: int = toInt(0);

    /** …and nothing older than this, so a long-stopped scheduler does not flood a mailbox on restart. */
    @unit("days")
    ignoreNotificationsOlderThan: int | null;

    sendBehavior: SendAlertTypeBehavior = SendAlertTypeBehavior.All;

    /** Signum's `[PreserveOrder, NoRepeatValidator] MList<AlertTypeSymbol>` — a @part row per symbol,
     *  which is how altea models a collection of scalars (the symbol lives on the row's @valueField). */
    @noRepeatValidator()
    alertTypes: SendNotificationEmailTaskEntity_AlertType[];

    @quoted toString(): string { return SendNotificationEmailTaskEntity.niceName(); }
}

@part
export class SendNotificationEmailTaskEntity_AlertType extends Entity {
    @backReference task: Lite<SendNotificationEmailTaskEntity>;
    @rowOrder order: int;
    @valueField alertType: AlertTypeSymbol;
}

export enum SendAlertTypeBehavior {
    All,
    Include,
    Exclude,
}

export namespace SendNotificationEmailTaskOperation {
    export const Save: ExecuteSymbol<SendNotificationEmailTaskEntity> = init();
}

/**
 * Signum's `AlertLogic.AlertNotificationMail` — the e-mail model "here are your pending alerts", rendered
 * against the RECIPIENT (`@[Entity]` is the user) with the alerts as `@foreach[m:alerts] as $a`.
 *
 * altea divergence: Signum's model also exposes a static `TextFormatted(TemplateParameters)` that expands an
 * alert's `[prop:text](url)` placeholders into anchors inside the MAIL. That expansion is not ported here —
 * it lives in the client's `AlertsClient.format`, which is what the dropdown and the alert view render with,
 * so a mail shows the alert text as written. (The mail is a notification; the link is the app.)
 */
@reflect
export class AlertNotificationMail extends ModelEntity {
    /** The alerts this mail lists, newest first. */
    alerts: AlertEntity[];
}


// ---- Messages -------------------------------------------------------------------------------------------

export const AlertMessage = {
    Alert: msg("Alert"),
    NewAlert: msg("New Alert"),
    Alerts: msg("Alerts"),
    Alerts_Attended: msg("Attended"),
    Alerts_Future: msg("Future"),
    Alerts_NotAttended: msg("Not attended"),
    CheckedAlerts: msg("Checked"),
    CreateAlert: msg("Create Alert"),
    FutureAlerts: msg("Futures"),
    WarnedAlerts: msg("Warned"),
    CustomDelay: msg("Custom delay"),
    DelayDuration: msg("Delay duration"),
    MyActiveAlerts: msg("My active alerts"),
    YouDoNotHaveAnyActiveAlert: msg("You do not have any active alert"),
    _0SimilarAlerts: msg("{0} similar alerts"),
    _0HiddenAlerts: msg("{0} hidden alerts"),
    ViewMore: msg("View more"),
    CloseAll: msg("Close all"),
    AllMyAlerts: msg("All my alerts"),
    NewUnreadNotifications: msg("New unread notifications"),
    Title: msg("Title"),
    Text: msg("Text"),
    Hi0: msg("Hi {0},"),
    YouHaveSomePendingAlerts: msg("You have some pending alerts:"),
    PleaseVisit0: msg("Please visit {0}"),
    OtherNotifications: msg("Other notifications"),
    Expand: msg("Expand"),
    Collapse: msg("Collapse"),
    Show0AlertsMore: msg("Show {0} alerts more"),
    Show0GroupsMore1Remaining: msg("Show {0} groups more ({1} remaining)"),
    Ringing: msg("Ringing!"),
};

// The database schema this package's tables live in — altea's counterpart of Signum's
// `[assembly: AssemblySchemaName("alerts")]`. FOLDER-scoped, so it covers every type declared
// beside it; the name is logical and gets dialect-mapped (schemaForType), so Postgres sees it snaked.
setDefaultDatabaseSchema("alerts");

// ---- the two query expressions AlertLogic registers ------------------------------------------------------
//
// DECLARED here and IMPLEMENTED in server/AlertLogic: the body needs `table(...)`, but the declaration must
// be visible to the CLIENT too, or `token(a => a.alerts())` cannot be written. Signum declares them once for
// `Entity` (extension methods) and so does altea; OPTIONAL, because only the types `AlertLogic.start` names
// actually offer them as tokens.
declare module "@altea/altea/data/entity" {
    interface Entity {
        /** Every alert whose `target` is this entity. */
        alerts?(): IQuery<AlertEntity>;
        /** …narrowed to the ones addressed to the CURRENT user and due now. */
        myActiveAlerts?(): IQuery<AlertEntity>;
    }
}
