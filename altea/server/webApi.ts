// A thin, strongly-typed wrapper over Express (`ws`). Each route declares its request/response
// types via a descriptor { req?, res? }; the wrapper injects onto Express's own req/res:
//   - req.jsonTyped(): Promise<Req>   — reads + deserializes the body (Serializer for entities,
//                                       JSON for primitives/custom), typed from `req`.
//   - res.jsonTyped(obj: Res): void   — serializes + sends, typed from `res`.
//   - res.modelState(ic): void        — sends 400 { modelState } from an IntegrityCheck.
// The raw Express req/res/app are all still available (ws.app), and — like Express — you finish a
// request by calling res.* (there is NO auto-serialize-on-return). The descriptor is also stashed
// on the injected handler (handler.httpMeta) so an OpenAPI/Swagger generator can walk the router.
//
// Type vocabulary (no thunks): a bare entity class, ArrayOf(Class), LiteOf(Class),
// Primitive("bool"|"number"|"string"), or CustomType<T>() (compiles + JSON round-trips, but no
// swagger schema).

import express, { type Express, type Request, type Response, type RequestHandler } from "express";
import { BaseEntity, type Entity } from "../data/entity";
import type { Lite } from "../data/lite";
import { RuntimeType, ClassType, ArrayType, LiteType, LiteralType } from "./runtimeTypes";
import { Serializer, resolveSerializationAuthContext } from "../data/serializer";
import type { IntegrityCheck } from "../data/validation";
import { HeavyProfiler } from "./profiler/heavyProfiler";
import { TimeTracker } from "./profiler/timeTracker";
import { UserHolder } from "./userHolder";
import { CultureInfo } from "../data/utils/cultureInfo";
import { Metadata } from "../data/metadata";
import { attachHubs, type WebSocketHub } from "./webSocketHub";

// A class reference (abstract-tolerant, so `Entity`/`BaseEntity` bases are accepted).
type Ctor<T> = abstract new (...args: any[]) => T;

// Phantom type + RuntimeType descriptor for a request/response payload. (De)serialization is NOT
// here — the WebBuilder always uses altea's Serializer ("altea/json", entities/serializer). The
// `runtimeType` is altea's canonical type (the same ClassType/ArrayType/LiteType/... used by
// PropertyRoute + the query binder); OpenAPI schemas are DERIVED from it. `undefined` for
// CustomType (an arbitrary TS type with no runtime representation).
export interface TypeRef<T> {
    readonly __t?: T; // phantom, carries T for inference/typing
    readonly runtimeType?: RuntimeType;
}

// A descriptor is either a bare entity class or a TypeRef.
type Ref<T> = TypeRef<T> | Ctor<T>;
type RefType<R> = R extends TypeRef<infer T> ? T : R extends Ctor<infer T> ? T : never;

function entityRef<T extends BaseEntity>(ctor: Ctor<T>): TypeRef<T> {
    return { runtimeType: new ClassType(ctor as unknown as Function) };
}

// A JSON graph is an ENTITY payload if described by a bare class; otherwise it's the given TypeRef.
function resolveRef<T>(ref: Ref<T>): TypeRef<T> {
    return typeof ref === "function"
        ? (entityRef(ref as unknown as Ctor<BaseEntity>) as unknown as TypeRef<T>)
        : ref;
}

// ---- Type-ref constructors -------------------------------------------------------------------

export function ArrayOf<T extends BaseEntity>(ctor: Ctor<T>): TypeRef<T[]> {
    return { runtimeType: new ArrayType(new ClassType(ctor as unknown as Function)) };
}

export function LiteOf<T extends Entity>(ctor: Ctor<T>): TypeRef<Lite<T>> {
    return { runtimeType: new LiteType(new ClassType(ctor as unknown as Function)) };
}

type PrimitiveName = "bool" | "number" | "string";
type PrimitiveType<K extends PrimitiveName> = K extends "bool" ? boolean : K extends "number" ? number : string;

export function Primitive<K extends PrimitiveName>(kind: K): TypeRef<PrimitiveType<K>> {
    const rt = kind === "bool" ? LiteralType.boolean : kind === "number" ? LiteralType.number : LiteralType.string;
    return { runtimeType: rt };
}

// Any other type: compiles + round-trips via the Serializer, but has no RuntimeType (no swagger).
export function CustomType<T>(): TypeRef<T> {
    return {};
}

// ---- ws wrapper ------------------------------------------------------------------------------

export interface RouteDef {
    params?: Ref<any>; // types req.params (a pure typing/OpenAPI hint — params are already on req)
    req?: Ref<any>;
    res?: Ref<any>;
    // Signum's [SignumAllowAnonymous]: this route is reachable without authentication. When an auth
    // module installs an authorization gate (setAuthorizeRequest), every OTHER route is denied unless a
    // user is authenticated — this flag opts a route out (login, boot metadata, error reporting).
    allowAnonymous?: boolean;
}

type ReqBody<D extends RouteDef> = D["req"] extends Ref<any> ? RefType<D["req"]> : never;
type ResBody<D extends RouteDef> = D["res"] extends Ref<any> ? RefType<D["res"]> : never;
type ParamsOf<D extends RouteDef> = D["params"] extends Ref<any> ? RefType<D["params"]> : Request["params"];

export type TypedRequest<B, P> = Omit<Request, "params"> & { params: P; jsonTyped(): Promise<B> };
export type TypedResponse<R> = Response & {
    jsonTyped(obj: R): void;
    modelState(ic: IntegrityCheck): void;
};

type Handler<D extends RouteDef> = (
    req: TypedRequest<ReqBody<D>, ParamsOf<D>>,
    res: TypedResponse<ResBody<D>>,
) => void | Promise<void>;

export interface HttpMeta {
    verb: string;
    path: string;
    allowAnonymous?: boolean;
    // altea RuntimeTypes (undefined when unspecified or CustomType); an OpenAPI generator maps
    // these to schemas.
    paramsType?: RuntimeType;
    reqType?: RuntimeType;
    resType?: RuntimeType;
}

// Pluggable per-request authorization gate (Signum's SignumAuthenticationFilter). An auth module
// installs it via setAuthorizeRequest; the route wrapper calls it AFTER routing (so meta.allowAnonymous
// is known) and INSIDE the request's async/user-context scope (so it can read the current user). It
// throws to reject — the terminal exception filter maps AuthenticationException/UnauthorizedAccessException
// to HTTP 403. Undefined (no auth module installed) → no enforcement: the framework runs open, as before.
export type AuthorizeRequest = (meta: HttpMeta) => void;
let _authorizeRequest: AuthorizeRequest | undefined;
export function setAuthorizeRequest(fn: AuthorizeRequest | undefined): void { _authorizeRequest = fn; }

// Pluggable request-body deserializer (Signum's model binder / JsonConverter). The default is the pure,
// isomorphic Serializer.parse. A server module can REPLACE it — e.g. property authorization installs a
// deserializer that resolves an existing entity's DB original and overlays the incoming changes onto it,
// so read-only / hidden properties keep their stored value (the write-gate). This is where "the retrieve
// is implicit inside the deserializer" lives: handlers just call req.jsonTyped(); the DB fetch happens
// here, not in each route. May be async (it can await the DB).
export type RequestDeserializer = (body: string, authContext?: unknown) => unknown | Promise<unknown>;
let _requestDeserializer: RequestDeserializer = body => Serializer.parse(body);
export function setRequestDeserializer(fn: RequestDeserializer): void { _requestDeserializer = fn; }

const rawBody = express.text({ type: "*/*", limit: "16mb" });

// The UI culture for a request: the client's `Accept-Language` (a bare locale tag — the client sends
// exactly the culture it rendered with), honoured only when metadata is actually loaded for it. Anything
// else — no header, an unknown tag, a full browser Accept-Language list — falls back to the process
// default, which is the untranslated source language.
function requestCulture(req: Request): string {
    // `headers` is optional-chained: a hand-built request object (the route unit tests invoke handlers
    // directly, without Express) has none, and a missing header is exactly the default-culture case.
    const header = req.headers?.["accept-language"];
    const tag = (Array.isArray(header) ? header[0] : header)?.trim();
    return tag != null && Metadata.cultures().includes(tag) ? tag : CultureInfo.currentUICulture();
}

export class WebBuilder {
    constructor(public readonly app: Express) { }

    // WebSocket hubs, keyed by path (Signum's `WebApplication.MapHub<T>("/api/xxxHub")`). Registered by a
    // module's `Logic.start`, then bound to the http.Server by `attachWebSockets` — the host calls that
    // after `app.listen`, because an upgrade handler needs the server, not the Express app.
    private readonly hubs = new Map<string, WebSocketHub>();

    webSocket(hub: WebSocketHub): void {
        const already = this.hubs.get(hub.path);
        if (already != undefined && already !== hub)
            throw new Error(`A different WebSocketHub is already registered at '${hub.path}'`);
        this.hubs.set(hub.path, hub);
    }

    /** Binds every registered hub to the listening server. Call once, after `app.listen(...)`. */
    attachWebSockets(server: Parameters<typeof attachHubs>[0]): void {
        attachHubs(server, this.hubs);
    }

    get<D extends RouteDef>(path: string, def: D, handler: Handler<D>): void { this.route("get", path, def, handler); }
    post<D extends RouteDef>(path: string, def: D, handler: Handler<D>): void { this.route("post", path, def, handler); }
    put<D extends RouteDef>(path: string, def: D, handler: Handler<D>): void { this.route("put", path, def, handler); }
    delete<D extends RouteDef>(path: string, def: D, handler: Handler<D>): void { this.route("delete", path, def, handler); }
    patch<D extends RouteDef>(path: string, def: D, handler: Handler<D>): void { this.route("patch", path, def, handler); }

    private route<D extends RouteDef>(verb: string, path: string, def: D, handler: Handler<D>): void {
        const paramsRef = def.params != null ? resolveRef(def.params) : undefined; // schema/OpenAPI only
        const reqRef = def.req != null ? resolveRef(def.req) : undefined;
        const resRef = def.res != null ? resolveRef(def.res) : undefined;

        const wrapped: RequestHandler & { httpMeta?: HttpMeta } = (req, res, next) => {
            // The IMMUTABLE serialization-auth snapshot for THIS request, resolved once (below) before the
            // handler and read synchronously by both the request write-gate and the response codec — a
            // captured snapshot, so a concurrent rule invalidation can't affect this request's serialization.
            let authCtx: unknown;
            // (de)serialization is delegated to altea's Serializer ("altea/json") — reqRef/resRef are
            // only for the OpenAPI schema below.
            (req as any).jsonTyped = () => {
                const body = (req as { body?: string }).body;
                return body ? Promise.resolve(_requestDeserializer(body, authCtx)) : Promise.resolve(undefined);
            };
            (res as any).jsonTyped = (obj: unknown) => res.type("application/json").send(Serializer.stringify(obj, { authContext: authCtx }));
            // Flat ModelState body (field → message), NO `exceptionType` — the exact shape the client's
            // ThrowErrorFilter turns into a ValidationError. Same shape the exceptionFilter emits for a
            // Saver IntegrityCheckException, so every validation failure reaches the client identically.
            (res as any).modelState = (ic: IntegrityCheck) => res.status(400).json(ic.errors);
            // Authorization gate first (secure-by-default when an auth module is installed), then resolve the
            // per-request auth snapshot (role known now; a no-op unless a property-auth module installed a
            // resolveContext), then the handler. All funnel rejections to `next` → the exception filter.
            // The whole request runs under a HeavyProfiler "Web.API <VERB>" span (Signum's SignumFilters
            // resource filter) so every nested SQL/LINQ/save span hangs under it, plus an always-on
            // TimeTracker keyed by the route PATTERN (Signum's SignumTimesTrackerFilter — the one and only
            // TimeTracker call site). Opening the spans at the top of this async scope makes the ambient
            // `current` span propagate (AsyncLocalStorage) into the awaited handler.
            // Per-request CULTURE (Signum's ASP.NET request-localization middleware, driven there by a
            // culture cookie). Without it every server-produced label — a registered expression's niceName,
            // a validation message, an exception message — would resolve in the PROCESS default culture no
            // matter who asked. The client sends its culture on every call (client/Services), and only a
            // culture with translations loaded is honoured, so a bogus header falls back to the default.
            //
            // BOTH cultures are scoped (withCultures), not just the UI one: server-side formatting should
            // follow the caller as well, and a per-culture cache that keys on `currentCulture()` would
            // otherwise key on a constant and serve whichever language warmed it first to everyone.
            const culture = requestCulture(req);
            void HeavyProfiler.runScope(async () => CultureInfo.withCultures(culture, async () => {
                using _prof = HeavyProfiler.log("Web.API " + verb.toUpperCase(), () => req.originalUrl);
                using _time = TimeTracker.start(verb.toUpperCase() + " " + path, req.originalUrl, () => UserHolder.currentUserLite()?.toString());
                try {
                    if (_authorizeRequest != null) _authorizeRequest(wrapped.httpMeta!);
                    authCtx = await resolveSerializationAuthContext();
                    await (handler as (r: Request, s: Response) => unknown)(req, res);
                } catch (e) {
                    next(e);
                }
            }));
        };
        wrapped.httpMeta = { verb, path, allowAnonymous: (def as RouteDef).allowAnonymous, paramsType: paramsRef?.runtimeType, reqType: reqRef?.runtimeType, resType: resRef?.runtimeType };

        const mws: RequestHandler[] = reqRef != null ? [rawBody] : [];
        (this.app as any)[verb](path, ...mws, wrapped);
    }

    // JSON error funnel (add AFTER routes). Unexpected error -> 500. (Validation is explicit, via
    // res.modelState.)
    useDefaultErrorHandler(): void {
        this.app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        });
    }
}

// Convenience factory (Signum's SignumServer host setup): a fresh Express app wrapped in a WebBuilder.
// The Express app is reachable as `ws.app` for static serving / listen.
/**
 * The `Content-Disposition` value for a download, in BOTH forms — ASP.NET's
 * `File(bytes, contentType, fileName)` writes the same pair, and `Services.getFileName` reads the
 * `filename*=` one first (as Signum's does):
 *
 *   attachment; filename="Pedido ano.xlsx"; filename*=UTF-8''Pedido%20a%C3%B1o.xlsx
 *
 * The quoted ASCII form is the LEGACY fallback, so it must stay readable text with `"` and `\` replaced
 * (a quote inside it would close the value early — and a browser sanitises one in a download name to "_").
 * Percent-encoding belongs ONLY in the `filename*=` form, which is what RFC 5987 defines; putting it in
 * the plain `filename=` makes a non-ASCII name arrive as literal escapes.
 */
export function attachmentDisposition(fileName: string): string {
    return `attachment; filename="${fileName.replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function createWebServer(): WebBuilder {
    return new WebBuilder(express());
}

