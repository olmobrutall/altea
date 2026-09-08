import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, uniqueIndex, implementedByAll, quoted } from "@altea/altea/data/decorators";
import { stringLengthValidator, validate, ValidationMessage } from "@altea/altea/data/validators";
import type { ExecuteSymbol } from "@altea/altea/data/operations";
import type { ITaskEntity } from "@altea/altea-scheduler/data/Scheduler";
import { UserQueryEntity } from "@altea/altea-user-queries/data/UserQuery";
import { ModelConverterSymbol } from "@altea/altea-templating/data/Templating";
import { EmailTemplateEntity } from "./EmailTemplate";

// Port of Signum.Mailing/Package/SendEmailTask.cs — a SCHEDULED TASK that sends one template: to nothing
// (a template with no query), to one fixed target, or to every row a user query returns. The third form is
// what EmailPackageLogic.sendMultipleEmailsAsync exists for.
//
// altea divergence: Signum spells the enum `EmaiTemplateTargetFrom` — a typo (missing "l") that reached its
// table name. Spelled correctly here; nothing in a Signum database depends on it, because the enum's table
// only exists where this task type is included.

/** Signum's `EmaiTemplateTargetFrom` (sic) — where the template's target entity comes from. */
export enum EmailTemplateTargetFrom {
    /** The template has no query, so it renders without a target. */
    NoTarget,
    /** One fixed entity, named on the task. */
    Unique,
    /** Every distinct entity a user query returns. */
    UserQuery,
}

@reflect
@entity("Main", "Master")
export class SendEmailTaskEntity extends Entity implements ITaskEntity {

    @uniqueIndex
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    emailTemplate: Lite<EmailTemplateEntity>;

    targetFrom: EmailTemplateTargetFrom = EmailTemplateTargetFrom.NoTarget;

    // Signum's `[ImplementedByAll] Lite<Entity>? UniqueTarget` — the target may be of any type the
    // template's query is implemented by, which is not known until the template is chosen.
    //
    // Signum's `PropertyValidation`: `(pi, UniqueTarget).IsSetOnlyWhen(TargetFrom == Unique)` — set when
    // that is the mode, unset otherwise. (Its three OTHER validations compare the target's type against
    // the template query's implementations; those need a QueryDescription and are not ported — see
    // server/SendEmailTaskLogic.)
    @implementedByAll
    @validate<SendEmailTaskEntity>(t => isSetOnlyWhen(
        t.uniqueTarget, t.targetFrom == EmailTemplateTargetFrom.Unique,
        SendEmailTaskEntity.nicePropertyName(a => a.uniqueTarget)))
    uniqueTarget: Lite<Entity> | null = null;

    @validate<SendEmailTaskEntity>(t => isSetOnlyWhen(
        t.targetsFromUserQuery, t.targetFrom == EmailTemplateTargetFrom.UserQuery,
        SendEmailTaskEntity.nicePropertyName(a => a.targetsFromUserQuery)))
    targetsFromUserQuery: Lite<UserQueryEntity> | null = null;

    modelConverter: ModelConverterSymbol | null = null;

    @quoted toString(): string { return this.name; }
}

/** Signum's `(pi, value).IsSetOnlyWhen(condition)` — the value must be present exactly when the condition
 *  holds. Local to this file; promote it if a second caller appears. */
function isSetOnlyWhen(value: unknown, condition: boolean, propertyName: string): string | null {
    if (condition && value == null)
        return ValidationMessage._0IsNotSet.niceToString(propertyName);
    if (!condition && value != null)
        return ValidationMessage._0ShouldBeNull.niceToString(propertyName);
    return null;
}

/** Signum's `[AutoInit] SendEmailTaskOperation`. */
export namespace SendEmailTaskOperation {
    export const Save: ExecuteSymbol<SendEmailTaskEntity> = init();
}
