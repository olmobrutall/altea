import { reflect, init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import {
    entity, part, column, uniqueIndex, quoted, backReference, rowOrder, implementedBy, legacyPropertyRoute,
} from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import { msg } from "@altea/altea/data/utils/localization";
import { Temporal, type int } from "@altea/altea/data/basics";
import { BigStringEmbedded } from "@altea/altea/data/bigString";
import { ExceptionEntity } from "@altea/altea/data/exception";
import type { IUserEntity } from "@altea/altea/data/security";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { UserEntity } from "@altea/altea-auth/data/User";

// The two halves of the module: an API KEY that authenticates a machine caller, and a LOG of every request
// that reached the app's public REST surface, replayable against a live host so a response can be diffed
// against what it used to be.
//
// Port of Signum.Rest's RestApiKeyEntity.cs + RestLog.cs — see port/Rest.md.

@reflect
@entity("Main", "Master")
export class RestApiKeyEntity extends Entity {

    /** Who the key acts as. A request carrying it is authenticated as this user, with their roles. */
    user: Lite<UserEntity>;

    /**
     * The secret. `min: 20` is long enough that the default generator's 32 random bytes (43 base64url
     * characters) are the only realistic way to fill it, and short keys are rejected rather than silently
     * accepted. `@uniqueIndex` because it is the lookup key of the authenticator's cache.
     */
    @uniqueIndex
    @stringLengthValidator({ min: 20, max: 100 })
    apiKey: string;

    @quoted

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

    queryString: QueryStringValueEntity[];

    /**
     * `IUserEntity` is an INTERFACE with no runtime constructor, so the implementations are declared empty
     * here and the app widens them — `overrideImplementedBy(RestLogEntity, r => r.user, () => [UserEntity])`
     * in its EntityOverrides. Same shape as `ExceptionEntity.user`.
     */
    @implementedBy(() => [])
    user: Lite<IUserEntity> | null = null;

    userHostAddress: string | null = null;

    userHostName: string | null = null;

    referrer: string | null = null;

    /** The matched route path. */
    @column({ size: 100 })
    controller: string;

    /** The name the app gave the logged API (`restLog({ name: "CatalogAPI" })`). */
    @column({ size: 100 })
    controllerName: string | null = null;

    /** The HTTP method. */
    @column({ size: 100 })
    action: string;

    @column({ size: 100 })
    machineName: string | null = null;

    @column({ size: 100 })
    applicationName: string | null = null;

    exception: Lite<ExceptionEntity> | null = null;

    responseBody: BigStringEmbedded = new BigStringEmbedded();

    // Declared but never assigned: the replay UI diffs the two response bodies in the browser and stores
    // nothing. Kept because the search page offers them as columns, and because a host that wants to
    // record a replay outcome has somewhere to put it.
    replayState: RestLogReplayState | null = null;

    changedPercentage: number | null = null;

    /** Whether this log may be re-sent to a live host. Set per logged API by the middleware's options. */
    allowReplay: boolean = false;

    /**
     * `@quoted`, so it IS a query column (the log's search page orders by it) — unlike the in-memory
     * `duration()` helpers in @altea/altea-processes / -scheduler / -migrations, which return the branded
     * `int` the transformer cannot emit a runtime type reference for. A plain `number` lowers to
     * `DATEDIFF(millisecond, start, end)` through `since().total()`.
     */
    @legacyPropertyRoute("Duration")
    @quoted durationMilliseconds(): number {
        return this.endDate.since(this.startDate).total({ unit: "milliseconds" });
    }

    // `@quoted` rather than a plain toString: both columns are on this same row, so the query provider
    // expands the string inline and materialises nothing.
    @quoted
    toString(): string {
        return `${this.httpMethod ?? ""} ${this.url ?? ""}`;
    }
}

/** One query-string parameter of a logged request. */
@reflect
@part
export class QueryStringValueEntity extends Entity {

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

setDefaultDatabaseSchema("rest");
