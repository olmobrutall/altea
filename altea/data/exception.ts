import { Entity } from "./entity";
import { Lite } from "./lite";
import { entity, column, implementedBy } from "./decorators";
import { reflect } from "./reflection";
import { Temporal, type int } from "./basics";
import { BigStringEmbedded } from "./bigString";
import type { IUserEntity } from "./security";

// Port of Signum's ExceptionEntity (old/Framework/Signum/Basics/Exception.cs). A "System" /
// "Transactional" entity (Not editable, Not RequiresSaveOperation — it is written by the engine, never
// by a user operation). It is the persisted record of every server (and reported client) error.
//
// altea divergences from Signum, documented inline:
//  - The big text fields (stackTrace, form, queryString, session, data) use the ported
//    BigStringEmbedded (data/bigString.ts), like Signum's `[BindParent] BigStringEmbedded`.
//    exceptionMessage / requestUrl / urlReferer stay plain unbounded `string | null` columns, as in
//    Signum (they were plain `[DbType(Size=int.MaxValue)] string?`, not BigStringEmbedded).
//  - `User: Lite<IUserEntity>?` — the user in scope when the error was logged. Signum sets ImplementedBy
//    to the single UserEntity; altea uses @implementedByAll (like target/origin on OperationLogEntity)
//    so altea (core) needn't name altea-auth's concrete UserEntity. Populated in exceptionFilter from
//    UserHolder (null until an auth module scopes a request).
//  - ExceptionOrigin.Backend_DotNet → Backend_Node (the backend is Node/TS, not .NET).
//  - TicksColumn(false) has no altea equivalent decorator yet; left as the schema default.
export enum ExceptionOrigin {
    Backend_Node,
    Frontend_React,
}

@entity("System", "Transactional")
export class ExceptionEntity extends Entity {
    creationDate: Temporal.PlainDateTime;

    @column({ size: 100 })
    exceptionType: string | null = null;

    // Signum computes ExceptionMessageHash in the setter; altea sets both together in ExceptionLogic.
    exceptionMessage: string | null = null;
    exceptionMessageHash: int = 0 as int;

    // Signum's `[BindParent] BigStringEmbedded StackTrace` — a non-null embedded whose `text` is nullable.
    stackTrace: BigStringEmbedded = new BigStringEmbedded();
    stackTraceHash: int = 0 as int;

    threadId: int = 0 as int;

    @column({ size: 100 })
    environment: string | null = null;

    @column({ size: 100 })
    version: string | null = null;

    @column({ size: 300 })
    userAgent: string | null = null;

    requestUrl: string | null = null;

    @column({ size: 100 })
    controllerName: string | null = null;

    @column({ size: 100 })
    actionName: string | null = null;

    urlReferer: string | null = null;

    @column({ size: 100 })
    machineName: string | null = null;

    @column({ size: 100 })
    applicationName: string | null = null;

    @column({ size: 100 })
    userHostAddress: string | null = null;

    @column({ size: 100 })
    userHostName: string | null = null;

    // Signum's `[BindParent] BigStringEmbedded` request-context fields (non-null embedded, nullable text).
    form: BigStringEmbedded = new BigStringEmbedded();
    queryString: BigStringEmbedded = new BigStringEmbedded();
    session: BigStringEmbedded = new BigStringEmbedded();
    data: BigStringEmbedded = new BigStringEmbedded();

    hResult: int = 0 as int;

    referenced: boolean = false;

    origin: ExceptionOrigin = ExceptionOrigin.Backend_Node;

    @column({ size: 100 })
    traceId: string | null = null;

    // Signum's `[ImplementedBy(typeof(UserEntity))] Lite<IUserEntity>? User`. Core declares NO
    // implementations (`@implementedBy(() => [])`) so it needn't reference altea-auth; the app overrides it
    // to the concrete user type via `overrideImplementedBy(ExceptionEntity, "user", () => [UserEntity])` in
    // its EntityOverrides (Signum's OverrideAttributes). Set in exceptionFilter.fillContext from UserHolder.
    @implementedBy(() => [])
    user: Lite<IUserEntity> | null = null;

    // Signum's ToString(): "{Type}: {message}".Etc(200).
    toString(): string {
        return `${this.exceptionType}: ${this.exceptionMessage ?? ""}`.slice(0, 200);
    }
}
