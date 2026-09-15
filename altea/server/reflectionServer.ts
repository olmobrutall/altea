// The reflection metadata HTTP API (Signum's ReflectionServer.cs / the client's ReflectionServer.ts).
// altea has NO runtime reflection blob for the entity SHAPE (that is emitted at compile time by the
// quote-transformer onto each constructor's TypeInfo/FieldInfo). This endpoint ships only what is
// runtime- / culture- / user-dependent and therefore cannot be baked into the shared entity classes —
// but, like Signum, it ships it as ONE `TypeMetadata` per type rather than as several parallel,
// differently-keyed sections:
//
//   niceName / nicePluralName / gender  — for the requested UI culture
//   fields[route].niceName              — ditto, keyed by PropertyRoute.propertyString()
//   fields[member].id                   — enum-member / symbol database ids
//   hasQuery                            — whether an executable query is registered (and visible)
//   operations                          — an OperationMetadata per operation registered on the type
//
// An authorization module widens the same objects (min/maxTypeAllowed, propertyAllowed) through its
// MetadataFilter, instead of bolting a separate map onto the envelope.
//
// Deliberately NOT here (they are static, identical for every user/culture, and needed BEFORE any
// entity is deserialized, so they live in the shared entity layer / EntityDeclarations, run by both
// tiers at startup): mixin registrations, lite-model constructors, implementedBy overrides.

import { Metadata } from "../data/metadata";
import type { MetadataBlob, TypeMetadata, FieldMetadata, OperationMetadata, KindOfType } from "../data/metadata";
import { Localization } from "../data/utils/localization";
import { CultureInfo } from "../data/utils/cultureInfo";
import type { QueryName } from "../data/dynamicQuery/queryUtils";
import { QueryLogic } from "./dynamicQuery/queryLogic";
import { OperationLogic } from "./operationLogic";
import { WebBuilder, CustomType } from "./webApi";
import {
    resolveType, resolveEnum, getRegisteredTypes, getRegisteredEnums, getRegisteredObjects,
    allDeclaredSymbols, getDefaultDescription,
} from "../data/registration";
import { EnumEntity, enumEntityMembers } from "../data/enumEntity";
import { PropertyRoute } from "../data/propertyRoute";
import { Entity, View } from "../data/entity";
import { TypeLogic } from "./typeLogic";
import type { TypeEntity } from "../data/typeEntity";

export namespace ReflectionServer {

    // Per-request, per-user overlay hook (Signum's ReflectionServer.TypeExtension / QueryExtension /
    // OperationExtension). An auth module installs it via setMetadataFilter; it runs inside the request's
    // user scope so it can role-filter the blob (clear `hasQuery`, stamp allowances, drop operations the
    // current role can't run). Undefined → the blob ships unfiltered (no auth module).
    //
    // The filter MUST treat the blob as its own to mutate and return: `buildMetadata` hands out a fresh,
    // deep-copied object per request precisely so a per-ROLE overlay can never leak into the shared
    // per-CULTURE store.
    export type MetadataFilter = (meta: MetadataBlob) => MetadataBlob | Promise<MetadataBlob>;
    let _metadataFilter: MetadataFilter | undefined;
    export function setMetadataFilter(fn: MetadataFilter | undefined): void { _metadataFilter = fn; }
    export function getMetadataFilter(): MetadataFilter | undefined { return _metadataFilter; }

    /**
     * The key a query occupies in `MetadataBlob.types` — its own type's entry, so `hasQuery` sits next
     * to that type's nice name. Exported so the auth filter can find the entry to clear.
     */
    export function metadataNameForQuery(queryName: QueryName): string {
        return queryName.name;
    }

    /**
     * Assemble the blob for a UI culture. Resolves names against the store snapshot for THAT locale plus
     * the code-declared defaults — never against the ambient UI culture — so it is callable from a plain
     * unit test as well as from inside a request, and a request for "es" never picks up "en" strings.
     */
    export function buildMetadata(culture: string): MetadataBlob {
        const translations = Metadata.forCulture(culture);
        const types: Record<string, TypeMetadata> = {};

        const typeOf = (name: string, kind: KindOfType): TypeMetadata => {
            let tm = types[name];
            if (tm == null) {
                const t = translations[name];
                const d = getDefaultDescription(name);
                tm = types[name] = { kind, fields: {} };
                // Only DECLARED names ride the wire. A name that equals what the client would humanise
                // anyway is pure payload, and a route-complete blob has a lot of those.
                const niceName = t?.niceName ?? d?.description;
                if (niceName != null && niceName !== Localization.Internal.niceNameFromName(name)) tm.niceName = niceName;
                const plural = t?.nicePluralName ?? d?.pluralDescription;
                if (plural != null) tm.nicePluralName = plural;
                const gender = t?.gender ?? d?.gender;
                if (gender != null) tm.gender = gender;
            }
            return tm;
        };

        // The declared label for one member/route of a container, or undefined when nothing is declared
        // or the declaration merely restates the humanised name.
        const declaredMember = (typeName: string, path: string): string | undefined => {
            const t = translations[typeName];
            const d = getDefaultDescription(typeName);
            const cap = capitalizePath(path);
            const declared = t?.fields?.[path]?.niceName ?? t?.fields?.[cap]?.niceName
                ?? d?.members[path] ?? d?.members[cap];
            return declared != null && declared !== Localization.Internal.niceMemberName(lastSegment(path))
                ? declared : undefined;
        };

        // ---- Entities / models -----------------------------------------------------------------------
        // One entry per reflected class, ABSTRACT BASES INCLUDED (Signum skips them; altea keeps them
        // because an operation or a property rule may be declared on a base, and `CustomerEntity.niceName()`
        // must still resolve). `fields` is route-keyed, so an embedded's members appear dotted under every
        // owner that reaches them — exactly what property authorization is keyed by.
        for (const ctor of getRegisteredTypes()) {
            // VIEWS are not part of the client's world: a View is a query-projection DTO the ENGINE
            // materialises (the sync SysTables / SysColumns family, temp-table shapes), with no page, no
            // operations, no property rules and no query a user can open. They were reaching the blob only
            // because they are registered types — 24 entries of pure noise on every boot.
            if (isViewType(ctor))
                continue;
            const tm = typeOf(ctor.name, ctor === Entity || ctor.prototype instanceof Entity ? "Entity" : "Model");
            for (const path of routesOf(ctor)) {
                const niceName = declaredMember(ctor.name, path);
                if (niceName != null) tm.fields[path] = { niceName };
            }
        }

        // ---- Enums -----------------------------------------------------------------------------------
        // Members carry their database id, so the client can build a Lite of an enum entity (a chart
        // colour palette, a filter value) without a round trip.
        for (const [name, enumObject] of getRegisteredEnums()) {
            const tm = typeOf(name, "Enum");
            for (const { id, name: member } of enumEntityMembers(enumObject)) {
                const fm: FieldMetadata = { id };
                const niceName = declaredMember(name, member);
                if (niceName != null) fm.niceName = niceName;
                tm.fields[member] = fm;
            }
        }

        // ---- Containers: message containers (msg) ----------------------------------------------------
        for (const [name, obj] of getRegisteredObjects()) {
            const tm = typeOf(name, "Container");
            for (const member of Object.keys(obj)) {
                const niceName = declaredMember(name, member);
                if (niceName != null) tm.fields[member] = { niceName };
            }
        }

        // ---- Containers: symbol containers (operations, permissions, type conditions) ----------------
        // Grouped by the container half of "<Container>.<Member>". Each member carries its symbol row id
        // (stamped onto these very instances by SymbolLogic's read-back), so the client can address a
        // symbol without a lookup.
        for (const symbol of allDeclaredSymbols()) {
            const dot = symbol.key.indexOf(".");
            if (dot < 0) continue;
            const container = symbol.key.slice(0, dot), member = symbol.key.slice(dot + 1);
            const tm = typeOf(container, "Container");
            const fm: FieldMetadata = tm.fields[member] ?? {};
            if (symbol.id != null) fm.id = symbol.id;
            const niceName = declaredMember(container, member);
            if (niceName != null) fm.niceName = niceName;
            tm.fields[member] = fm;
        }

        // ---- Queries ---------------------------------------------------------------------------------
        // Signum's TypeInfo.queryDefined. A query is named by its own type, so the flag rides on that
        // type's entry — beside the nice name whose PLURAL is the search page's title.
        for (const queryName of QueryLogic.queries.getQueryNames())
            typeOf(metadataNameForQuery(queryName), "Entity").hasQuery = true;

        // ---- Operations ------------------------------------------------------------------------------
        // Attached ONLY to the type that declares each operation as its owner (Graph options' entityType,
        // or a type that added itself via registerForType for an interface-owned one). The client walks
        // the prototype chain to find an inherited one.
        //
        // It used to be emitted for the declaring type AND every subclass of it, which is what
        // `operationsForType` answers — and that made the blob mostly duplicate: the two ConstructFroms
        // registered on `Entity` (CreateAlertFromEntity, CreateNoteFromEntity) were shipped 267 times
        // each, 136KB of a 437KB response, for two objects. A subclass's own entry still wins over an
        // inherited one of the same key, because the walk stops at the first type that has the key.
        for (const ctor of OperationLogic.typesWithOperations()) {
            const tm = typeOf(ctor.name, "Entity");
            for (const symbol of OperationLogic.declaredOperationsForType(ctor)) {
                const op = OperationLogic.tryFindOperation(symbol);
                if (op == null) continue;
                (tm.operations ??= {})[symbol.key] = buildOperation(symbol.key, op, declaredMember);
            }
        }

        // `hasConstructorOperation` stays PER CONCRETE TYPE, and so keeps walking the chain: it answers
        // "does this type have a Constructor at all", read BEFORE the per-role filter drops operations,
        // precisely so "has none" and "has one this role may not run" stay distinguishable (see the
        // field's own doc). One boolean per type is not what made the blob big.
        for (const ctor of getRegisteredTypes()) {
            const hasCtor = OperationLogic.operationsForType(ctor)
                .some(s => OperationLogic.tryFindOperation(s)?.operationType === "Constructor");
            if (hasCtor)
                typeOf(ctor.name, "Entity").hasConstructorOperation = true;
        }

        // ---- Anything TRANSLATED that the registries do not describe ----------------------------------
        // The passes above are registry-driven, and two important groups are invisible to them:
        //
        //  - a CLIENT-ONLY message container (SearchMessage, OperationMessage, …). Its `msg()` container is
        //    registered when the module that declares it is LOADED, and the server never loads the client
        //    layer — so `getRegisteredObjects()` cannot see it, even though the translation file has it.
        //  - a `@quoted` EXPRESSION member (Order.totalPrice). It is a method, not a field, so
        //    `PropertyRoute.generateRoutes` never yields it — but it IS a query column with a label.
        //
        // Both used to work only because the old blob shipped the translation file wholesale. So: carry over
        // every declared name/member the passes above did not already produce. A member is kept under the key
        // the translation declares (PascalCase, as Signum writes it); the lookups probe both cases, so it
        // still resolves from a camelCase route.
        for (const [name, t] of Object.entries(translations)) {
            const tm = typeOf(name, "Container");
            for (const [member, fm] of Object.entries(t.fields)) {
                if (fm.niceName == null) continue;
                if (tm.fields[member] != null || tm.fields[member.charAt(0).toLowerCase() + member.slice(1)] != null)
                    continue; // already emitted by a registry pass, under the route's own key
                if (fm.niceName !== Localization.Internal.niceMemberName(lastSegment(member)))
                    tm.fields[member] = { niceName: fm.niceName };
            }
        }

        return { culture, types };
    }

    export function start(ws: WebBuilder): void {
        // GET /api/reflection/metadata?culture=xx — plain JSON (no entities), so res.json (not the
        // entity Serializer). Culture defaults to the process/context UI culture.
        ws.get("/api/reflection/metadata",
            // allowAnonymous: the client fetches this at boot to render (among other things) the login
            // page, before any user is authenticated. The blob is role-filtered by the MetadataFilter
            // once an authorization module is installed.
            { res: CustomType<MetadataBlob>(), allowAnonymous: true },
            async (req, res) => {
                const culture = (req.query["culture"] as string | undefined) ?? CultureInfo.currentUICulture();
                let meta = buildMetadata(culture);
                if (_metadataFilter != null)
                    meta = await _metadataFilter(meta);
                res.json(toWire(meta));
            });

        // GET /api/reflection/cultures — the locales that have translations loaded, plus the process
        // default. altea has no CultureInfoEntity table (Signum's `/api/culture/cultures`): a culture is
        // only selectable if something translated it, so the loaded set is the catalogue. The DEFAULT
        // culture is always included even with nothing loaded for it — it is the untranslated source
        // language, and the picker must be able to get back to it.
        ws.get("/api/reflection/cultures",
            { res: CustomType<{ cultures: string[]; defaultCulture: string }>(), allowAnonymous: true },
            async (_req, res) => {
                // The PROCESS default, not `currentUICulture()` — this request already runs inside the
                // caller's own culture scope, so the current one would just echo the caller back and the
                // untranslated source language would vanish from the picker.
                const defaultCulture = CultureInfo.defaultUICulture();
                const cultures = Metadata.cultures();
                res.json({
                    cultures: cultures.includes(defaultCulture) ? cultures : [defaultCulture, ...cultures].sort(),
                    defaultCulture,
                });
            });

        // GET /api/reflection/typeEntity/:typeName — the persisted TypeEntity row for a (clean) type name
        // (Signum's ReflectionController.GetTypeEntity → `TypeLogic.TryGetType(name)?.ToTypeEntity()`).
        // altea: resolveType maps the clean name → ctor, then TypeLogic's warm type↔id↔entity caches yield
        // the TypeEntity. Returns JSON null when the name is unknown/unregistered. Entity-serialized via
        // jsonTyped so the client's ajaxGet revives a real TypeEntity. NOT anonymous (a logged-in lookup).
        ws.get("/api/reflection/typeEntity/:typeName",
            { params: CustomType<{ typeName: string }>(), res: CustomType<TypeEntity | null>() },
            async (req, res) => {
                // An entity type (typeRegistry → its ctor) or, for chart palettes on enum columns, an enum
                // type (enumRegistry → its closed EnumEntity<E> ctor via typeFor). Both have a TypeEntity row
                // when registered in the DB type table; typeToId is keyed by that ctor.
                let ctor = resolveType(req.params.typeName);
                if (ctor == null) {
                    const enumObj = resolveEnum(req.params.typeName);
                    if (enumObj != null)
                        ctor = EnumEntity.typeFor(enumObj as object) as Function;
                }
                // undefined when the type has no row in the DB type table — a lookup, not an error.
                const te = ctor == null ? undefined : (await TypeLogic.caches()).tryTypeToEntity(ctor);
                res.jsonTyped(te ?? null);
            });
    }
}

// Whether a registered type is a query-projection VIEW rather than something the client can hold. The
// `View` base itself counts: it is registered too, and is no more useful to a client than its subclasses.
function isViewType(ctor: Function): boolean {
    return ctor === View || ctor.prototype instanceof View;
}

// A type's property routes as propertyString()s. Structural (culture- and role-independent), so it is
// computed once per type instead of per request — the blob is assembled on every metadata fetch.
const routeCache = new Map<Function, string[]>();
function routesOf(ctor: Function): string[] {
    let routes = routeCache.get(ctor);
    if (routes == null)
        // `memberPaths`, not `generateRoutes`: this is a LABEL dictionary keyed by (declaring type,
        // member) — what `FieldInfo.niceToString()` reads — so a `@part` needs its own entry even though
        // a part may not be a route ROOT. See PropertyRoute.memberPaths.
        routeCache.set(ctor, routes = PropertyRoute.memberPaths(ctor));
    return routes;
}

// The blob as it goes OUT: drop each operation's `key`, which is already the record key that holds it
// (see OperationMetadata.key — the client stamps it back in applyMetadata). Done here, at the edge,
// rather than by never building it: `buildMetadata` is also what the server reads for its own lookups,
// and an OperationMetadata without its key is a worse object to hold than a slightly fatter one.
//
// Shallow per level, and only where it has to copy — the blob the filter hands over is already a fresh
// per-request deep copy, but `res.json` must not be the thing that mutates it.
function toWire(meta: MetadataBlob): MetadataBlob {
    const types: Record<string, TypeMetadata> = {};
    for (const [name, tm] of Object.entries(meta.types)) {
        if (tm.operations == null) { types[name] = tm; continue; }
        const operations: Record<string, OperationMetadata> = {};
        for (const [key, om] of Object.entries(tm.operations)) {
            const { key: _omitted, ...rest } = om;
            operations[key] = rest as OperationMetadata;
        }
        types[name] = { ...tm, operations };
    }
    return { ...meta, types };
}

function buildOperation(
    key: string,
    op: { operationType: OperationMetadata["operationType"] },
    declaredMember: (typeName: string, member: string) => string | undefined,
): OperationMetadata {
    const anyOp = op as Record<string, unknown>;
    const dot = key.indexOf(".");
    const container = dot >= 0 ? key.slice(0, dot) : key;
    const member = dot >= 0 ? key.slice(dot + 1) : key;
    // Every boolean below is emitted ONLY when true, and every reader already treats absent as false —
    // they are optional in the DTO. `"canBeNew" in op` was enough to write `canBeNew: false`, and a
    // false is the same information as saying nothing at 15 bytes a time.
    const info: OperationMetadata = {
        key,
        // Resolved here so the client needs no second lookup: the operation's label is a member of its
        // symbol CONTAINER ("OrderOperation" + "Ship"), not of the entity it is attached to.
        niceName: declaredMember(container, member) ?? Localization.Internal.niceMemberName(member),
        operationType: op.operationType,
    };
    if ("onCanExecute" in op) info.hasCanExecute = true;
    if (anyOp["getState"] != null) info.hasStates = true;
    if (anyOp["canBeNew"] === true) info.canBeNew = true;
    if (anyOp["canBeModified"] === true) info.canBeModified = true;
    if (anyOp["resultIsSaved"] === true) info.resultIsSaved = true;
    return info;
}

// The last segment of a property path: "shipAddress.city" → "city".
function lastSegment(path: string): string {
    const i = Math.max(path.lastIndexOf("."), path.lastIndexOf("]"));
    return i < 0 ? path : path.slice(i + 1);
}

// Capitalize each dot/bracket-separated segment: "shipAddress.city" → "ShipAddress.City". Signum's XML
// keys members by the PascalCase C# name; altea's routes are camelCase.
function capitalizePath(path: string): string {
    return path.replace(/(^|[.\]])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

