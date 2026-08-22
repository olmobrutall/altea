import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, ModelEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import {
    entity, implementedBy, implementedByAll, format, stringLengthValidator, uniqueIndex,
} from "@altea/altea/data/decorators";
import { noRepeatValidator } from "@altea/altea/data/validators";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { msg } from "@altea/altea/data/utils/localization";
import { registerEnum } from "@altea/altea/data/registration";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import type { IUserEntity } from "@altea/altea/data/security";
import { UserEntity } from "@altea/altea-auth/data/User";
import type { IQuery } from "@altea/altea/data/iquery";
import { WorkflowEntity } from "./Workflow";
import type { CaseActivityEntity } from "./CaseActivity";

// Port of Signum.Workflow's Case.cs — a CASE is one RUN of a workflow over one MAIN ENTITY. The main entity
// is the app's own business object (an order, a request), reached through `ICaseMainEntity`; the case adds
// the history, the tags and the parent link that decompositions need.

/**
 * Signum's ICaseMainEntity — the marker an app entity implements to be workflow-able. Registered with
 * `sb.include(X).withWorkflow(…)`, which is what supplies the constructor and the save.
 *
 * altea has no IEntity, so this extends the `Entity` CLASS (the shape data/security.ts uses for IUserEntity).
 *
 * The four members are Signum's EXTENSION METHODS on ICaseMainEntity (CaseActivityLogic.cs). altea cannot key
 * an extension token on an interface, so `withWorkflow` attaches them to each concrete main-entity type's
 * prototype and registers them there — which is exactly why they are declared OPTIONAL here: they exist only
 * once the type has been registered, and a required member would force four stub methods onto every app entity
 * that writes `implements ICaseMainEntity`.
 */
export interface ICaseMainEntity extends Entity {
    /** The case activities this entity has been through, newest last. */
    caseActivities?(): IQuery<CaseActivityEntity>;
    /** The cases (usually one) this entity is the subject of. */
    cases?(): IQuery<CaseEntity>;
    /** The most recent case activity, or null. */
    lastCaseActivity?(): Promise<CaseActivityEntity | null>;
    /** Does the CURRENT user have a notification on any of them? (the "in my inbox" column) */
    currentUserHasNotification?(): Promise<boolean>;
}

@reflect
@entity("System", "Transactional")
export class CaseEntity extends Entity {

    workflow: WorkflowEntity;

    /** Set when this case was spawned by a Decomposition / CallWorkflow activity of another case. */
    parentCase: Lite<CaseEntity> | null;

    @stringLengthValidator({ min: 1, max: 100 })
    description: string;

    /** Any app entity may be the subject of a case, so this is genuinely open (Signum's ImplementedByAll). */
    @implementedByAll
    mainEntity: ICaseMainEntity;

    startDate: Temporal.PlainDateTime = Clock.now;

    finishDate: Temporal.PlainDateTime | null;

    toString(): string {
        return this.description;
    }
}

export namespace CaseOperation {
    export const SetTags: ExecuteSymbol<CaseEntity> = init();
    export const Cancel: ExecuteSymbol<CaseEntity> = init();
    export const Reactivate: ExecuteSymbol<CaseEntity> = init();
    export const Delete: DeleteSymbol<CaseEntity> = init();
}

// ---- Tags -----------------------------------------------------------------------------------------------

@reflect
@entity("Main", "Master")
export class CaseTagTypeEntity extends Entity {

    @uniqueIndex
    @stringLengthValidator({ min: 2, max: 100 })
    name: string;

    @format("Color")
    @stringLengthValidator({ min: 3, max: 12 })
    color: string;

    toString(): string {
        return this.name;
    }
}

export namespace CaseTagTypeOperation {
    export const Save: ExecuteSymbol<CaseTagTypeEntity> = init();
}

@reflect
@entity("System", "Transactional")
export class CaseTagEntity extends Entity {

    creationDate: Temporal.PlainDateTime = Clock.now;

    case: Lite<CaseEntity>;

    tagType: CaseTagTypeEntity;

    @implementedBy(() => [UserEntity])
    createdBy: Lite<IUserEntity>;
}

/** What the "Set tags" operation edits: the tags now, plus the tags it started from (so the operation can
 *  tell removals from "someone else added it meanwhile"). A MODEL, so plain arrays. */
@reflect
export class CaseTagsModel extends ModelEntity {
    @noRepeatValidator()
    caseTags: CaseTagTypeEntity[];

    @noRepeatValidator()
    oldCaseTags: CaseTagTypeEntity[];
}

// ---- The case-flow color scale --------------------------------------------------------------------------

/** What the case-flow diagram shades an activity's duration against. UI-only (Signum marks it
 *  `[InTypeScript(true), DescriptionOptions(Members)]`), but registered so its members are translatable. */
export enum CaseFlowColor {
    CaseMaxDuration,
    AverageDuration,
    EstimatedDuration,
}
registerEnum(CaseFlowColor);

export const CaseMessage = {
    DeleteMainEntity: msg("Delete Main Entity"),
    DoYouWAntToAlsoDeleteTheMainEntity0: msg("Do you want to also delete the main entity: {0}"),
    DoYouWAntToAlsoDeleteTheMainEntities: msg("Do you want to also delete the main entities?"),
    SetTags: msg(),
};
