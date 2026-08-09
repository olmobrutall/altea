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
import { Serializer } from "../data/serializer";
import type { IntegrityCheck } from "../data/validation";

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

const rawBody = express.text({ type: "*/*", limit: "16mb" });

export class WebBuilder {
    constructor(public readonly app: Express) { }

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
            // (de)serialization is delegated to altea's Serializer ("altea/json") — reqRef/resRef are
            // only for the OpenAPI schema below.
            (req as any).jsonTyped = () => {
                const body = (req as { body?: string }).body;
                return Promise.resolve(body ? Serializer.parse(body) : undefined);
            };
            (res as any).jsonTyped = (obj: unknown) => res.type("application/json").send(Serializer.stringify(obj));
            // Flat ModelState body (field → message), NO `exceptionType` — the exact shape the client's
            // ThrowErrorFilter turns into a ValidationError. Same shape the exceptionFilter emits for a
            // Saver IntegrityCheckException, so every validation failure reaches the client identically.
            (res as any).modelState = (ic: IntegrityCheck) => res.status(400).json(ic.errors);
            // Authorization gate first (secure-by-default when an auth module is installed), then the
            // handler. Both funnel rejections to `next` → the exception filter.
            Promise.resolve()
                .then(() => { if (_authorizeRequest != null) _authorizeRequest(wrapped.httpMeta!); })
                .then(() => (handler as (r: Request, s: Response) => unknown)(req, res))
                .catch(next);
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
export function createWebServer(): WebBuilder {
    return new WebBuilder(express());
}

