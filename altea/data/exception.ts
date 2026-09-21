import { Entity } from "./entity";
import { Lite } from "./lite";
import { entity, column, forceNotNullable, implementedBy, ticksColumn } from "./decorators";
import { MAX_SIZE } from "./reflection";
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
//    Signum (they were plain `[DbType(Size=int.MaxValue)] string?`, not BigStringEmbedded) — which
//    since the column sizer gained Signum's per-provider default of 200 has to be SAID, hence the
//    `@column({ size: MAX_SIZE })` on each.
//  - `User: Lite<IUserEntity>?` — the user in scope when the error was logged. Signum sets ImplementedBy
//    to the single UserEntity; altea uses @implementedByAll (like target/origin on OperationLogEntity)
//    so altea (core) needn't name altea-auth's concrete UserEntity. Populated in exceptionFilter from
//    UserHolder (null until an auth module scopes a request).
//  - `ExceptionOrigin` is `Backend` / `Frontend`, where Signum writes `Backend_DotNet` /
//    `Frontend_React`. Naming the member after the TECHNOLOGY dates it — the backend here is Node, not
//    .NET, and neither half of the pair says anything the plain word does not. Signum is taking the
//    same two names, so the enum table converges; until it does, a legacy sync leaves the rows alone
//    (eastwind's simplifyDiffEnums registration).
//  - TicksColumn(false) has no altea equivalent decorator yet; left as the schema default.
export enum ExceptionOrigin {
    Backend,
    Frontend,
}

@entity("System", "Transactional")
// Signum's [TicksColumn(false)] — the engine writes these rows, never a person editing one, so there is
// nothing for a concurrency stamp to protect.
@ticksColumn(false)
export class ExceptionEntity extends Entity {
    creationDate: Temporal.PlainDateTime;

    // Signum's `[ForceNotNullable, DbType(Size = 100)] string?` — built up in pieces, so the field is
    // nullable, but no STORED exception has no type.
    @forceNotNullable
    @column({ size: 100 })
    exceptionType: string | null = null;

    // Signum computes ExceptionMessageHash in the setter; altea sets both together in ExceptionLogic.
    // Non-null, as Signum declares it: an exception without a message is not one worth storing.
    // Signum's `[DbType(Size = int.MaxValue)]` — an exception message is arbitrarily long, and a string
    // column with no size takes the per-provider default of 200.
    @column({ size: MAX_SIZE })
    exceptionMessage: string = "";
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

    // Signum's `[DbType(Size = int.MaxValue)]` — a URL with a query string outruns any sensible width.
    @column({ size: MAX_SIZE })
    requestUrl: string | null = null;

    @column({ size: 100 })
    controllerName: string | null = null;

    @column({ size: 100 })
    actionName: string | null = null;

    // Signum's `[DbType(Size = int.MaxValue)]`, as requestUrl above.
    @column({ size: MAX_SIZE })
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

    origin: ExceptionOrigin = ExceptionOrigin.Backend;

    @column({ size: 100 })
    traceId: string | null = null;

    // Signum's `[ImplementedBy(typeof(UserEntity))] Lite<IUserEntity>? User`. Core declares NO
    // implementations (`@implementedBy(() => [])`) so it needn't reference altea-auth; the app overrides it
    // to the concrete user type via `overrideImplementedBy(ExceptionEntity, e => e.user, () => [UserEntity])` in
    // its EntityOverrides (Signum's OverrideAttributes). Set in exceptionFilter.fillContext from UserHolder.
    @implementedBy(() => [])
    user: Lite<IUserEntity> | null = null;

    // Signum's ToString(): "{Type}: {message}".Etc(200).
    toString(): string {
        return `${this.exceptionType}: ${this.exceptionMessage ?? ""}`.slice(0, 200);
    }
}
