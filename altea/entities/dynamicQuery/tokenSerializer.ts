// JSON (de)serialization for the SERVER-ONLY query sub-tokens (Phase 2 of [[querytoken-to-entities-refactor]]).
//
// The metadata sub-tokens (properties, collection element/count, date parts, …) are generated LOCALLY
// on both sides from the shared token model, so they never cross the wire. Only the tokens the client
// cannot compute — extensions (and later manual / operations) — are produced by the server and shipped
// as JSON, then rebuilt here as real entities token instances hanging off the client's local parent.
//
// This module lives in entities because both sides use it: the server SERIALIZES, the client
// DESERIALIZES. It maps the value objects a token carries — RuntimeType, Implementations, PropertyRoute
// — to/from their name-based wire forms (a ctor can't cross the wire; its clean name can).

import { cleanTypeName, resolveCleanType, resolveEnum } from "../registration";
import {
    RuntimeType, ClassType, LiteType, ArrayType, LiteralType, TemporalType, EnumType,
} from "../runtimeTypes";
import { Implementations } from "../implementations";
import { PropertyRoute } from "../propertyRoute";
import type { QueryToken } from "./tokens/queryToken";
import { ExtensionToken, type ExtensionInfo } from "./tokens/extensionToken";

// ---- RuntimeType <-> JSON --------------------------------------------------------------------

export type RuntimeTypeJson =
    | { k: "class"; type: string }
    | { k: "lite"; inner: RuntimeTypeJson }
    | { k: "array"; inner: RuntimeTypeJson }
    | { k: "lit"; t: "boolean" | "number" | "string" | "null" }
    | { k: "temporal"; kind: "dateTime" | "date" | "duration" }
    | { k: "enum"; name: string };

export function serializeRuntimeType(rt: RuntimeType): RuntimeTypeJson {
    if (rt instanceof ClassType) return { k: "class", type: cleanTypeName(rt.constructorFunction) };
    if (rt instanceof LiteType) return { k: "lite", inner: serializeRuntimeType(rt.entityType) };
    if (rt instanceof ArrayType) return { k: "array", inner: serializeRuntimeType(rt.elementType!) };
    if (rt instanceof LiteralType) return { k: "lit", t: rt.typeName };
    if (rt instanceof TemporalType) return { k: "temporal", kind: rt.kind };
    if (rt instanceof EnumType) return { k: "enum", name: rt.enumName };
    throw new Error(`serializeRuntimeType: unsupported RuntimeType ${rt.constructor.name} in a query token`);
}

export function deserializeRuntimeType(j: RuntimeTypeJson): RuntimeType {
    switch (j.k) {
        case "class": {
            const ctor = resolveCleanType(j.type);
            if (ctor == undefined) throw new Error(`deserializeRuntimeType: type '${j.type}' is not registered`);
            return new ClassType(ctor);
        }
        case "lite": return new LiteType(deserializeRuntimeType(j.inner));
        case "array": return new ArrayType(deserializeRuntimeType(j.inner));
        case "lit": return LiteralType[j.t];
        case "temporal": return new TemporalType(j.kind);
        case "enum": {
            const e = resolveEnum(j.name);
            if (e == undefined) throw new Error(`deserializeRuntimeType: enum '${j.name}' is not registered`);
            return new EnumType(e, j.name);
        }
    }
}

// ---- Implementations <-> JSON (the @implementedBy clean-name list, or "[ALL]") ---------------

export function serializeImplementations(i: Implementations | undefined): string | undefined {
    if (i == undefined) return undefined;
    return i.isByAll ? "[ALL]" : i.types.map(cleanTypeName).join(", ");
}

export function deserializeImplementations(s: string | undefined): Implementations | undefined {
    if (s == undefined) return undefined;
    if (s === "[ALL]") return Implementations.byAll;
    const ctors = s.split(", ").map(n => {
        const c = resolveCleanType(n);
        if (c == undefined) throw new Error(`deserializeImplementations: type '${n}' is not registered`);
        return c;
    });
    return Implementations.by(...ctors);
}

// ---- Server-only token <-> JSON --------------------------------------------------------------

// A serialized server-only token. `tokenType` discriminates the concrete class; the remaining fields
// are its serializable metadata. (Only ExtensionToken today; ManualToken / OperationToken follow the
// same shape when they arrive.)
export interface ServerTokenJson {
    tokenType: "Extension";
    key: string;
    niceName: string;
    resultType: RuntimeTypeJson;
    isProjection: boolean;
    implementations?: string;
    propertyRoute?: string;
    allowedReason?: string | null;
}

// Whether a token is one the client CANNOT generate from local metadata and must fetch — i.e. one
// `serializeServerToken` knows how to ship. Used to pick the server-only tokens out of a parent's
// full sub-token set. (ExtensionToken today; ManualToken / OperationToken join the union later.)
export function isServerOnlyToken(token: QueryToken): boolean {
    return token instanceof ExtensionToken;
}

// Server side: flatten a generated server-only token to its wire form (resolving the lazy
// niceName / allowedReason thunks in the request's culture + auth context).
export function serializeServerToken(token: QueryToken): ServerTokenJson {
    if (token instanceof ExtensionToken) {
        const i = token.info;
        return {
            tokenType: "Extension",
            key: i.key,
            niceName: i.niceName(),
            resultType: serializeRuntimeType(i.resultType),
            isProjection: i.isProjection,
            implementations: serializeImplementations(i.implementations),
            propertyRoute: i.propertyRoute?.toString(),
            allowedReason: i.allowedReason?.() ?? null,
        };
    }
    throw new Error(`serializeServerToken: unsupported token ${token.constructor.name} (fullKey '${token.fullKey()}')`);
}

// Client side: rebuild the token as a real entities instance hanging off the local `parent`. The
// resolved niceName / allowedReason come back as constant thunks; `serverInfo` stays undefined (a
// client token never builds a SQL expression).
export function deserializeServerToken(json: ServerTokenJson, parent: QueryToken): QueryToken {
    switch (json.tokenType) {
        case "Extension": {
            const info: ExtensionInfo = {
                key: json.key,
                niceName: () => json.niceName,
                resultType: deserializeRuntimeType(json.resultType),
                isProjection: json.isProjection,
                implementations: deserializeImplementations(json.implementations),
                propertyRoute: json.propertyRoute != undefined ? PropertyRoute.parseFull(json.propertyRoute) : undefined,
                allowedReason: () => json.allowedReason ?? null,
            };
            return new ExtensionToken(parent, info);
        }
    }
}
