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

import { cleanTypeName, resolveCleanType, resolveEnum, enumNameOf } from "../registration";
import { TypeReference, type TypeName, type SubTypeName } from "../reflection";
import { Implementations } from "../implementations";
import { PropertyRoute } from "../propertyRoute";
import type { QueryToken } from "./tokens/queryToken";
import { ExtensionToken, type ExtensionInfo } from "./tokens/extensionToken";

// ---- TypeReference <-> JSON ------------------------------------------------------------------
// A ctor/enum can't cross the wire — its clean name can; the client rebuilds the `type` thunk via the
// registry (resolveCleanType / resolveEnum). Value types travel as typeName + subTypeName.

export interface TypeReferenceJson {
    typeName?: TypeName;
    subTypeName?: SubTypeName;
    ref?: string;                    // clean name of the referenced entity/embedded ctor or enum
    refKind?: "class" | "enum";
    lite?: boolean;
    array?: boolean;
    isNullable?: boolean;
}

export function serializeTypeReference(tr: TypeReference): TypeReferenceJson {
    const j: TypeReferenceJson = {};
    const ctor = tr.getFunction();
    const en = tr.getEnum();
    if (ctor != undefined) { j.ref = cleanTypeName(ctor); j.refKind = "class"; }
    else if (en != undefined) { j.ref = enumNameOf(en) ?? ""; j.refKind = "enum"; }
    else { j.typeName = tr.typeName; if (tr.subTypeName != undefined) j.subTypeName = tr.subTypeName; }
    if (tr.lite) j.lite = true;
    if (tr.array) j.array = true;
    if (tr.isNullable) j.isNullable = true;
    return j;
}

export function deserializeTypeReference(j: TypeReferenceJson): TypeReference {
    const tr = new TypeReference({ typeName: j.typeName, subTypeName: j.subTypeName, lite: j.lite, array: j.array, isNullable: j.isNullable });
    if (j.ref != undefined) {
        const name = j.ref;
        tr.type = j.refKind === "enum"
            ? () => { const e = resolveEnum(name); if (e == undefined) throw new Error(`deserializeTypeReference: enum '${name}' is not registered`); return e; }
            : () => { const c = resolveCleanType(name); if (c == undefined) throw new Error(`deserializeTypeReference: type '${name}' is not registered`); return c; };
    }
    return tr;
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
    resultType: TypeReferenceJson;
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
            resultType: serializeTypeReference(i.resultType),
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
                resultType: deserializeTypeReference(json.resultType),
                isProjection: json.isProjection,
                implementations: deserializeImplementations(json.implementations),
                propertyRoute: json.propertyRoute != undefined ? PropertyRoute.parseFull(json.propertyRoute) : undefined,
                allowedReason: () => json.allowedReason ?? null,
            };
            return new ExtensionToken(parent, info);
        }
    }
}
