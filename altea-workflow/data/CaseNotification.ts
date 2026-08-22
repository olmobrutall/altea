import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, ModelEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, implementedBy, stringLengthValidator } from "@altea/altea/data/decorators";
import { Temporal } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import { registerEnum } from "@altea/altea/data/registration";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { UserEntity } from "@altea/altea-auth/data/User";
import { RoleEntity } from "@altea/altea-auth/data/Role";
import { CaseActivityEntity } from "./CaseActivity";

// Port of Signum.Workflow's CaseNotification.cs — one row per USER who should act on a pending activity, and
// how far that user has got with it. This is what the Inbox lists, and `actor` records WHY the user got it
// (themselves, or a role they are in).

export enum CaseNotificationState {
    New,
    Opened,
    InProgress,
    Done,
    DoneByOther,
}
registerEnum(CaseNotificationState);

@reflect
@entity("System", "Transactional")
export class CaseNotificationEntity extends Entity {

    caseActivity: Lite<CaseActivityEntity>;

    user: Lite<UserEntity>;

    @implementedBy(() => [UserEntity, RoleEntity])
    actor: Lite<Entity>;

    @stringLengthValidator({ multiLine: true })
    remarks: string | null;

    state: CaseNotificationState = CaseNotificationState.New;
}

export namespace CaseNotificationOperation {
    export const SetRemarks: ExecuteSymbol<CaseNotificationEntity> = init();
    export const Delete: DeleteSymbol<CaseNotificationEntity> = init();
    export const CreateCaseNotificationFromCaseActivity:
        ConstructSymbol<CaseNotificationEntity, From<CaseActivityEntity>> = init();
}

/** The Inbox's simple filter builder — a date range plus the states to show. A MODEL, so plain arrays. */
@reflect
export class InboxFilterModel extends ModelEntity {
    range: DateFilterRange = DateFilterRange.LastMonth;
    states: CaseNotificationState[];
    fromDate: Temporal.PlainDateTime | null;
    toDate: Temporal.PlainDateTime | null;
}

export enum DateFilterRange {
    All,
    LastWeek,
    LastMonth,
    CurrentYear,
}
registerEnum(DateFilterRange);

export const InboxMessage = {
    Clear: msg(),
    Activity: msg(),
    SenderNote: msg(),
    Sender: msg(),
    Filters: msg(),
};
