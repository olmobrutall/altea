import { reflect } from './reflection';
import { Entity } from './entity';
import { entity, implementedBy } from './decorators';
import { stringLengthValidator } from './validators';
import { Lite } from './lite';
import { Temporal } from './basics';
import type { IUserEntity } from './security';
import { ExceptionEntity } from './exception';

// Port of Signum's SystemEventLogEntity (old/Framework/Signum/Basics/SystemEventLog.cs) — a line per
// notable thing that happened to the PROCESS rather than to any one entity: the application starting and
// stopping, and whatever else a host chooses to record.
//
// It lives in CORE, as it does in Signum (Signum/Basics), because "the application started" is not an
// extension's concern and because the writer needs nothing but the connector.
//
// Its value is being the one table that answers "was the server even up then?" — which is why it is
// written in its OWN transaction and never throws (see server/systemEventLogLogic): the log of a restart
// is useless if a restart during a failure is exactly when it goes missing.

@reflect
@entity("System", "Transactional")
export class SystemEventLogEntity extends Entity {
    @stringLengthValidator({ min: 3, max: 100 })
    machineName: string;

    date: Temporal.PlainDateTime;

    // Signum's `Lite<IUserEntity>? User`. Core declares NO implementations (`@implementedBy(() => [])`) so
    // it needn't reference altea-auth; the app overrides it to the concrete user type via
    // `overrideImplementedBy(SystemEventLogEntity, s => s.user, () => [UserEntity])` in its EntityOverrides —
    // the same accommodation ExceptionEntity.user and OperationLogEntity.user already make.
    //
    // Nullable for a reason that is not incidental: the two events the module ships ("Application Start" /
    // "Application Stop") have no user at all, so this column is empty for exactly the rows that matter
    // most.
    @implementedBy(() => [])
    user: Lite<IUserEntity> | null = null;

    @stringLengthValidator({ min: 3, max: 100 })
    eventType: string;

    exception: Lite<ExceptionEntity> | null = null;
}
