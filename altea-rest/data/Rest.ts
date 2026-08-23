import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import {
    entity, column, uniqueIndex, quoted, backReference, rowOrder, implementedBy,
    stringLengthValidator,
} from "@altea/altea/data/decorators";
import { msg } from "@altea/altea/data/utils/localization";
import { Temporal, type int } from "@altea/altea/data/basics";
import { BigStringEmbedded } from "@altea/altea/data/bigString";
import { ExceptionEntity } from "@altea/altea/data/exception";
import type { IUserEntity } from "@altea/altea/data/security";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { UserEntity } from "@altea/altea-auth/data/User";

// Port of Signum.Rest's RestApiKeyEntity.cs + RestLog.cs — the two halves of the module: an API KEY that
// authenticates a machine caller, and a LOG of every request that reached the app's public REST surface,
// replayable against a live host so a response can be diffed against what it used to be.
//
// altea divergences:
//  - **`MList<QueryStringValueEmbedded>` → `@part` rows.** Signum marks the collection `[PreserveOrder]`,
//    which is exactly a `@rowOrder` child table here. The type keeps Signum's NAME, "Embedded" suffix
//    included, as altea-tour's `CssStepEmbedded` and the AD configurations do.
//  - **`ControllerName` is what the CALLER names its API**, and `controller` / `action` follow altea's own
//    established mapping for "which endpoint was this" — the one `exceptionFilter.fillContext` already
//    uses, since altea has no MVC controller/action pair to read: `controller` is the matched route path
//    and `action` is the HTTP method. See server/RestLogFilter.server.ts.
//  - **`ReplayState` / `ChangedPercentage` are declared but never assigned**, exactly as in Signum: the
//    replay UI diffs the two response bodies in the browser and stores nothing. They are kept because the
//    search page offers them as columns, and because a host that wants to record a replay outcome has
//    somewhere to put it.

@reflect
@entity("Main", "Master")
export class RestApiKeyEntity extends Entity {

    /** Who the key acts as. A request carrying it is authenticated as this user, with their roles. */
    user: Lite<UserEntity>;

    /**
     * The secret. `min: 20` is Signum's — long enough that the default generator's 32 random bytes
     * (43 base64url characters) are the only realistic way to fill it, and short keys are rejected rather
     * than silently accepted. `@uniqueIndex` because it is the lookup key of the authenticator's cache.
     */
    @uniqueIndex
    @stringLengthValidator({ min: 20, max: 100 })
    apiKey: string;

    toString(): string {
        return this.user?.toString() ?? "";
    }
}

export namespace RestApiKeyOperation {
    export const Save: ExecuteSymbol<RestApiKeyEntity> = init();
    export const Delete: DeleteSymbol<RestApiKeyEntity> = init();
}

export const RestApiKeyMessage = {
    GenerateApiKey: msg("Generate API key"),
};

// ---- the log ------------------------------------------------------------------------------------

@reflect
@entity("System", "Transactional")
export class RestLogEntity extends Entity {

    @column({ size: 100 })
    httpMethod: string | null = null;

    /** The request PATH (no query string — that is `queryString` below, one row per parameter). */
    url: string;

    startDate: Temporal.PlainDateTime;

    endDate: Temporal.PlainDateTime;

    /** When this log was last replayed. Set by whoever replays it; the module itself never writes it. */
    replayDate: Temporal.PlainDateTime | null = null;

    requestBody: BigStringEmbedded = new BigStringEmbedded();

    /** Signum's `[PreserveOrder] MList<QueryStringValueEmbedded>` — see the header. */
    queryString: QueryStringValueEmbedded[];

    /**
     * Signum's `Lite<IUserEntity>?`. As with `ExceptionEntity.user`, `IUserEntity` is an INTERFACE with no
     * runtime constructor, so the implementations are declared empty here and the app widens them —
     * `overrideImplementedBy(RestLogEntity, "user", () => [UserEntity])` in its EntityOverrides. This
     * module does depend on altea-auth (Signum.Rest depends on Signum.Authorization too), but the LOG's
     * user is the framework's `IUserEntity` slot, so it follows core's pattern rather than hard-wiring
     * a concrete type into the column.
     */
    @implementedBy(() => [])
    user: Lite<IUserEntity> | null = null;

    userHostAddress: string | null = null;

    userHostName: string | null = null;

    referrer: string | null = null;

    /** The matched route path — altea's counterpart of Signum's controller TYPE (see the header). */
    @column({ size: 100 })
    controller: string;

    /** The name the app gave the logged API (`restLog({ name: "CatalogAPI" })`). */
    @column({ size: 100 })
    controllerName: string | null = null;

    /** The HTTP method — altea's counterpart of Signum's action NAME (see the header). */
    @column({ size: 100 })
    action: string;

    @column({ size: 100 })
    machineName: string | null = null;

    @column({ size: 100 })
    applicationName: string | null = null;

    exception: Lite<ExceptionEntity> | null = null;

    responseBody: BigStringEmbedded = new BigStringEmbedded();

    replayState: RestLogReplayState | null = null;

    changedPercentage: number | null = null;

    /** Whether this log may be re-sent to a live host. Set per logged API by the middleware's options. */
    allowReplay: boolean = false;

    /**
     * Signum's `Duration` — `[Unit("ms"), ExpressionField]` over `(EndDate - StartDate).TotalMilliseconds`.
     *
     * `@quoted` here, so it IS a query column (the log's search page orders by it), unlike the in-memory
     * `duration()` helpers in @altea/altea-processes / -scheduler / -migrations: those return the branded
     * `int`, which the transformer cannot emit a runtime type reference for, while a plain `number` lowers
     * to `DATEDIFF(millisecond, start, end)` through `since().total()`.
     */
    @quoted durationMilliseconds(): number {
        return this.endDate.since(this.startDate).total({ unit: "milliseconds" });
    }

    toString(): string {
        return `${this.httpMethod ?? ""} ${this.url ?? ""}`;
    }
}

/** One query-string parameter of a logged request. A collection row, hence an entity — see the header. */
@reflect
@entity("Part", "Transactional")
export class QueryStringValueEmbedded extends Entity {

    @backReference restLog: Lite<RestLogEntity>;

    @rowOrder order: int;

    key: string;

    value: string | null = null;

    toString(): string {
        return `${this.key ?? ""}=${this.value ?? ""}`;
    }
}

export enum RestLogReplayState {
    NoChanges,
    WithChanges,
}

export const RestLogMessage = {
    Replay: msg("Replay"),
    ReplayNotAllowedForThisRestLog: msg("Replay not allowed for this rest log"),
    Previous: msg("Previous"),
    Difference: msg("Difference"),
    Current: msg("Current"),
};
