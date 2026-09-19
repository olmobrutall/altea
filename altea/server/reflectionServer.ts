// The reflection metadata HTTP API (Signum's ReflectionServer.cs / the client's ReflectionServer.ts).
// altea has NO runtime reflection blob for the entity SHAPE (that is emitted at compile time by the
// quote-transformer onto each constructor's TypeInfo/FieldInfo). This endpoint ships only what is
// runtime- / culture- / user-dependent and therefore cannot be baked into the shared entity classes —
// but, like Signum, it ships it as ONE `TypeMetadata` per type rather than as several parallel,
// differently-keyed sections:
//
//   niceName / nicePluralName / gender  — for the requested UI culture
//   fields[member].niceName             — ditto, for the type's OWN members
//   fields[member].id                   — symbol database ids (an enum member's id IS its numeric value)
//   routes[path]                        — what the ROLE may do with a member reached by that path
//   hasQuery                            — whether an executable query is registered (and visible)
//   operations                          — an OperationMetadata per operation registered on the type
//
// `fields` and `routes` are two key spaces and are kept apart on purpose — a label depends on the type
// that DECLARES a member and nothing else, while an allowance depends on the whole path that reaches it.
// For `Order.shipAddress.city` the label is `AddressEmbedded.fields["city"]` and the allowance is
// `OrderEntity.routes["shipAddress.city"]`. See FieldMetadata / RouteMetadata in data/metadata.
//
// An authorization module widens the same objects (maxTypeAllowed, propertyAllowed) through its
// MetadataFilter, instead of bolting a separate map onto the envelope — and REMOVES the types the role
// may not read, which is why every readable type keeps an entry here even when it has nothing to say.
//
// Deliberately NOT here (they are static, identical for every user/culture, and needed BEFORE any
// entity is deserialized, so they live in the shared entity layer / EntityDeclarations, run by both
// tiers at startup): mixin registrations, lite-model constructors, implementedBy overrides.

import { Metadata } from "../data/metadata";
import type {
    MetadataBlob, MetadataBlobWire, TypeMetadata, TypeMetadataWire, FieldMetadata, FieldMetadataWire,
    OperationMetadata, KindOfType,
} from "../data/metadata";
import { Localization } from "../data/utils/localization";
import { CultureInfo } from "../data/utils/cultureInfo";
import type { QueryName } from "../data/dynamicQuery/queryUtils";
import { QueryLogic } from "./dynamicQuery/queryLogic";
import { OperationLogic } from "./operationLogic";
import type { IOperation } from "./operation";
import { WebBuilder, CustomType } from "./webApi";
import {
    resolveType, resolveEnum, getRegisteredTypes, getRegisteredEnums, getRegisteredObjects,
    allDeclaredSymbols, getDefaultDescription, enumNameOf,
} from "../data/registration";
import { EnumEntity } from "../data/enumEntity";
import { Enum } from "../data/enum";
import { PropertyRoute } from "../data/propertyRoute";
import { serializeExtensionInfo } from "../data/dynamicQuery/tokenSerializer";
import { Entity, View } from "../data/entity";
import { TypeLogic } from "./typeLogic";
import type { TypeEntity } from "../data/typeEntity";

export namespace ReflectionServer {

    // Per-request, per-user overlay hook (Signum's ReflectionServer.TypeExtension / QueryExtension /
    // OperationExtension). An auth module installs it via setMetadataFilter; it runs inside the request's
    // user scope so it can role-filter the blob — DROP the types the role cannot read (Signum's
    // TypeExtension returning null), clear `hasQuery`, stamp the allowances that remain. Undefined → the
    // blob ships unfiltered (no auth module), which is also what makes "no entry" mean "not allowed"
    // safely: with nothing installed, nothing is ever removed.
    //
    // The filter MUST treat the blob as its own to mutate and return: `buildMetadata` hands out a fresh,
    // deep-copied object per request precisely so a per-ROLE overlay can never leak into the shared
    // per-CULTURE store.
    export type MetadataFilter = (meta: MetadataBlob) => MetadataBlob | Promise<MetadataBlob>;
    let _metadataFilter: MetadataFilter | undefined;
    export function setMetadataFilter(fn: MetadataFilter | undefined): void {
        _metadataFilter = fn;
        invalidateMetadataCache();
    }
    export function getMetadataFilter(): MetadataFilter | undefined { return _metadataFilter; }

    // ---- the per (culture, role) blob cache ----------------------------------------------------------
    //
    // Signum caches the serialized blob rather than rebuilding it per request, and this route is hit by
    // every client at boot: for eastwind that was ~35ms and 186KB of freshly built object graph each time,
    // walking all 540 registered types to resolve their operations and expressions.
    //
    // ONE cache keyed by BOTH inputs, rather than a per-culture layer under a per-role one. A per-culture
    // layer would have to be CLONED on every read — the filter's contract is that the blob is its own to
    // mutate — and cloning the whole graph is most of what building it costs, so the second layer would buy
    // little while adding a way for one role's overlay to leak into the shared copy. Keyed this way each
    // combination is built exactly once and the mutable blob never outlives the request that owns it.
    //
    // The two inputs run on different clocks:
    //  - CULTURE changes rarely — the translation XMLs are read at boot — but it is NOT immutable: the
    //    translation editor saves a file and re-reads that culture into the store. So this subscribes to
    //    the store rather than assuming, which is the difference between an invariant and a comment.
    //  - ROLE is not: an authorization rule change rewrites what the filter removes. Auth owns that clock,
    //    so it supplies the key and calls `invalidateMetadataCache()`; core has no notion of a role.
    const wireCache = new Map<string, Promise<MetadataBlobWire>>();

    // The blob is assembled FROM the translation store, so any write to it stales every cached payload —
    // a caption saved in the editor must reach the next request, not the next restart. Dropping all
    // cultures rather than just the one that changed keeps this honest for free: at boot the cache is
    // empty anyway, and a save is not a hot path.
    Metadata.onChanged.push(() => invalidateMetadataCache());

    /**
     * What makes one viewer's blob differ from another's — the current ROLE, supplied by the auth module
     * that installed the filter. Undefined (no auth module) means the blob is the same for everyone and
     * culture alone keys the cache.
     */
    let _metadataCacheKey: (() => string) | undefined;
    export function setMetadataCacheKey(fn: (() => string) | undefined): void {
        _metadataCacheKey = fn;
        invalidateMetadataCache();
    }

    /**
     * When the blob last changed — Signum's `ReflectionServer.LastModified`. Bumped by every invalidation.
     */
    let lastModified = Date.now();
    export function metadataLastModified(): number { return lastModified; }

    /**
     * The validator behind the endpoint's 304, identifying the exact REPRESENTATION: which culture, which
     * role, and which generation of the blob.
     *
     * An ETag rather than Signum's `Last-Modified`, because altea derives the culture from the request
     * (cookie / user / Accept-Language) instead of from the URL, so one URL legitimately has several
     * bodies. A bare timestamp cannot say which one a cache is holding: after switching language the
     * browser revalidated `?culture=de`, the stamp had not moved, and it went on serving the ENGLISH body
     * it had cached under that URL. Naming the representation makes "not modified" mean what it says.
     */
    function metadataETag(culture: string): string {
        return `W/"${culture}.${_metadataCacheKey?.() ?? ""}.${lastModified}"`;
    }

    /** Drop every cached blob. Auth calls this whenever a rule change makes the overlay stale. */
    export function invalidateMetadataCache(): void {
        wireCache.clear();
        lastModified = Date.now();
    }

    /** How many (culture, role) payloads are currently held — for tests and the cache statistics panel. */
    export function metadataCacheSize(): number { return wireCache.size; }

    /**
     * The wire payload for a culture in the CURRENT request's role, reused when one was already built for
     * that pair. This — not `buildMetadata` — is what the route answers with.
     */
    export function cachedWire(culture: string): Promise<MetadataBlobWire> {
        // JSON-encoded rather than glued with a separator, so no culture or role key can spell another
        // pair's key.
        const key = JSON.stringify([culture, _metadataCacheKey?.() ?? ""]);
        let p = wireCache.get(key);
        if (p == undefined) {
            p = (async () => {
                let meta = buildMetadata(culture);
                if (_metadataFilter != null)
                    meta = await _metadataFilter(meta);
                return toWire(meta);
            })();
            // A rejected promise must not stay cached, or one transient failure (the filter reading a rule
            // cache outside a transaction, say) would be served until restart — the trap ResetLazy
            // self-evicts for.
            p.catch(() => { if (wireCache.get(key) === p) wireCache.delete(key); });
            wireCache.set(key, p);
        }
        return p;
    }

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

        // The declared label for one MEMBER of the type that declares it, or undefined when nothing is
        // declared or the declaration merely restates the humanised name. Signum's XML keys members by
        // the PascalCase C# name; altea's members are camelCase, so both spellings are probed.
        const declaredMember = (typeName: string, member: string): string | undefined => {
            const t = translations[typeName];
            const d = getDefaultDescription(typeName);
            const cap = member.charAt(0).toUpperCase() + member.slice(1);
            const declared = t?.fields?.[member]?.niceName ?? t?.fields?.[cap]?.niceName
                ?? d?.members[member] ?? d?.members[cap];
            return declared != null && declared !== Localization.Internal.niceMemberName(member)
                ? declared : undefined;
        };

        // ---- Entities / models -----------------------------------------------------------------------
        // One entry per reflected class, ABSTRACT BASES INCLUDED (Signum skips them; altea keeps them
        // because an operation or a property rule may be declared on a base, and `CustomerEntity.niceName()`
        // must still resolve).
        //
        // `fields` holds a type's OWN members. An embedded, a `@part` and a mixin are each registered types
        // in their own right, so their members are described ONCE, under themselves — which is the pair
        // `FieldInfo.niceToString()` looks up, whatever route reached the member. This used to walk
        // `PropertyRoute.memberPaths`, which expands every embedded member under every owner that reaches
        // it, and then probe the translations for each of those dotted paths: eastwind's blob carried ZERO
        // such entries in any culture (a translation file names a member under the type that declares it),
        // so the whole cross-product was lookups thrown away on every metadata request.
        for (const ctor of getRegisteredTypes()) {
            // VIEWS are not part of the client's world: a View is a query-projection DTO the ENGINE
            // materialises (the sync SysTables / SysColumns family, temp-table shapes), with no page, no
            // operations, no property rules and no query a user can open. They were reaching the blob only
            // because they are registered types — 24 entries of pure noise on every boot.
            if (isViewType(ctor))
                continue;
            const tm = typeOf(ctor.name, ctor === Entity || ctor.prototype instanceof Entity ? "Entity" : "Model");
            for (const member of ownMembersOf(ctor)) {
                const niceName = declaredMember(ctor.name, member);
                if (niceName != null) tm.fields[member] = { niceName };
            }
        }

        // ---- Enums -----------------------------------------------------------------------------------
        // The NICE NAME, and nothing else. An enum member's row id is its own numeric value — it is not
        // read from the database, it is what SEEDS it (`schemaGenerator` inserts `(id, name)` straight from
        // `enumEntityMembers`, and the synchronizer reconciles against the same list), so it cannot differ.
        // `data/enumEntity` is isomorphic, so a client that needs those ids calls `enumEntityMembers`
        // itself — which is exactly what altea-chart's ColorPalette does to build its `Lite<EnumEntity<E>>`
        // values. Shipping them here cost a field per member in a blob built per user AND per culture, and
        // the only reader of `FieldMetadata.id` is the SYMBOL pass below, whose ids really are assigned by
        // the database.
        //
        // Iterate the member NAMES (`Enum.values`), not the rows: `enumEntityMembers` filters to numeric
        // members, so a STRING-valued enum — the whole query-token vocabulary, AggregateFunction /
        // CollectionElementType / … — yielded nothing and its translations never reached the client at all.
        // A `markAsNotMapped` member was in the same position.
        for (const [name, enumObject] of getRegisteredEnums()) {
            const tm = typeOf(name, "Enum");
            for (const member of Enum.values(enumObject as Record<string, string | number>)) {
                // Only a DECLARED label rides the wire, exactly as for an entity's members above: a member
                // the client would humanise identically is pure payload, and with the id gone there is
                // nothing else an entry could carry.
                const niceName = declaredMember(name, member);
                if (niceName != null) tm.fields[member] = { niceName };
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
                (tm.operations ??= {})[symbol.key] = buildOperation(symbol.key, op, ctor, declaredMember);
            }
        }

        // ---- Registered expressions (extension tokens) -----------------------------------------------
        // An expression is registered against a TYPE, so it belongs in the per-type blob the client
        // already has — not in a request per TOKEN of that type, which is what it used to cost: opening
        // one chart fired a dozen GETs to /serverTokens, most of them for a parent that had none.
        //
        // Same rule as operations: emitted on the DECLARING type, found by walking the chain, so the ones
        // registered on `Entity` (Alerts, Notes, OperationLogs, SystemValidFrom …) are shipped once rather
        // than per entity. The niceName and allowedReason thunks resolve HERE, which is where the request's
        // culture and role are — the two reasons this could never be baked into the compile-time TypeInfo.
        // `serializeExtensionInfo` resolves the niceName / allowedReason THUNKS, and a thunk reads the
        // AMBIENT UI culture — every other name here comes from the `translations` snapshot this function
        // was handed. Without the scope the two disagree: a blob built for "es" shipped its extensions in
        // whatever culture the request happened to be running in (the process default for the anonymous
        // boot fetch), so `Order.TotalPrice` stayed "Total price" among Spanish column headers while the
        // same expression resolved correctly everywhere the thunk ran inside a request scope.
        CultureInfo.withUICulture(culture, () => {
            for (const [source, infos] of QueryLogic.expressions.declaredExtensions()) {
                const name = typeof source === "function" ? source.name : enumNameOf(source);
                if (name == undefined) continue;
                const tm = typeOf(name, typeof source === "function" ? "Entity" : "Enum");
                for (const info of infos)
                    (tm.extensions ??= {})[info.key] = serializeExtensionInfo(info);
            }
        });

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
        // still resolves from a camelCase member.
        //
        // A DOTTED declaration — `<Member Name="BonusTrack.Name"/>` under the OWNER — is skipped, and that
        // is the one behaviour this split removes. `fields` is keyed by (declaring type, member) now, so
        // the label for that member belongs under BonusTrackEmbedded, which is where every translation file
        // in the workspace already puts it. Carrying the dotted key over would put a key in this record
        // that no reader can ever hit.
        for (const [name, t] of Object.entries(translations)) {
            const tm = typeOf(name, "Container");
            for (const [member, fm] of Object.entries(t.fields)) {
                if (fm.niceName == null) continue;
                if (/[.\/\[\]]/.test(member)) continue; // a path, not a member of this type
                if (tm.fields[member] != null || tm.fields[member.charAt(0).toLowerCase() + member.slice(1)] != null)
                    continue; // already emitted by a registry pass, under the member's own key
                if (fm.niceName !== Localization.Internal.niceMemberName(member))
                    tm.fields[member] = { niceName: fm.niceName };
            }
        }

        return { culture, types };
    }

    // The blob as it goes OUT — the model squeezed into the wire encoding described on `MetadataBlobWire`,
    // which `Metadata.fromWire` undoes on arrival:
    //
    //   - a field whose ONLY fact is its label becomes that label. A route-complete blob is mostly labels,
    //     and `{"niceName":` + `}` is 13 bytes of wrapper around each one;
    //   - an EMPTY `fields` is dropped rather than shipped as `"fields":{}`. Most types declare no label at
    //     all — every member name that humanises to itself is already omitted — so this is the common case;
    //   - each operation's `key` is dropped, because it is already the record key that holds it.
    //
    // Done here, at the edge, rather than by never building the full shape: `buildMetadata` is also what the
    // server reads for its own lookups, and a half-filled object is a worse thing to hold than a fat one.
    //
    // Shallow per level, and it copies rather than mutating — the blob the filter hands over is already a
    // fresh per-request deep copy, but `res.json` must not be the thing that edits it.
    export function toWire(meta: MetadataBlob): MetadataBlobWire {
        const types: Record<string, TypeMetadataWire> = {};
        for (const [name, tm] of Object.entries(meta.types)) {
            // `routes` rides along in `rest`, untouched: it exists only where a role has something to
            // say, so there is nothing in it to squeeze out.
            const { fields, operations, ...rest } = tm;
            const tw: TypeMetadataWire = rest;

            const members = Object.keys(fields);
            if (members.length > 0) {
                const wire: Record<string, FieldMetadataWire> = {};
                for (const member of members) {
                    const fm = fields[member];
                    // `niceName` alone, and nothing else set — including nothing an extension widened on.
                    const keys = Object.keys(fm);
                    wire[member] = keys.length === 1 && keys[0] === "niceName" ? fm.niceName! : fm;
                }
                tw.fields = wire;
            }

            if (operations != null) {
                const wireOps: Record<string, OperationMetadata> = {};
                for (const [key, om] of Object.entries(operations)) {
                    const { key: _omitted, ...restOp } = om;
                    wireOps[key] = restOp as OperationMetadata;
                }
                tw.operations = wireOps;
            }

            types[name] = tw;
        }
        return { culture: meta.culture, types };
    }

    export function start(ws: WebBuilder): void {
        // GET /api/reflection/metadata — plain JSON (no entities), so res.json (not the entity Serializer).
        //
        // The blob is built for the REQUEST's culture, which webApi already resolved and scoped (cookie →
        // user → Accept-Language → default) — Signum's ReflectionController does the same, deriving
        // everything from the ambient culture.
        //
        // `?culture=` (and `?user=`/`?userTicks=`) are CACHE BUSTERS only, and are deliberately not read:
        // they make the URL differ so the browser's HTTP cache treats another language or another user as
        // another resource, which is what the 304 below is paired with. Signum sends the same three for
        // the same reason and its controller ignores them too. Honouring the parameter instead was how the
        // blob's culture could disagree with the request's — the bug that shipped every registered
        // expression in the process default language.
        ws.get("/api/reflection/metadata",
            // allowAnonymous: the client fetches this at boot to render (among other things) the login
            // page, before any user is authenticated. The blob is role-filtered by the MetadataFilter
            // once an authorization module is installed.
            { res: CustomType<MetadataBlobWire>(), allowAnonymous: true },
            async (req, res) => {
                // The payload is ~186KB and changes only when something invalidates the cache, so a boot
                // that changed nothing costs an empty 304 instead of the whole blob — and the check runs
                // BEFORE the blob is built or serialized, so a 304 is nearly free on the server too.
                const culture = CultureInfo.currentUICulture();
                const etag = metadataETag(culture);
                res.setHeader("ETag", etag);
                res.setHeader("Cache-Control", "no-cache");   // revalidate, don't serve blind from cache
                // The body depends on request state that is NOT in the URL, so any cache between here and
                // the browser has to key on it too.
                res.setHeader("Vary", "Accept-Language, Cookie");

                const inm = req.headers?.["if-none-match"];
                const offered = (Array.isArray(inm) ? inm.join(",") : inm ?? "").split(",").map(t => t.trim());
                if (offered.includes(etag)) {
                    res.status(304).end();
                    return;
                }

                res.json(await cachedWire(culture));
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

// A type's OWN members — the first step of each of its routes, and nothing below it. Structural (culture-
// and role-independent), so it is computed once per type instead of per request; the blob is assembled on
// every metadata fetch.
//
// `memberPaths`, not `generateRoutes`: a `@part` may not be a route ROOT, yet its members still need their
// own entries here, because this is a LABEL dictionary keyed by (declaring type, member) and that is what
// `FieldInfo.niceToString()` reads whatever route reaches the member. See PropertyRoute.memberPaths.
//
// Filtering to depth 1 is what keeps that promise: a deeper path belongs to the type that DECLARES its
// last step, and that type describes it under itself. A mixin step (`[SomeMixin].member`) goes the same
// way — a mixin is a reflected type of its own, so its members ride on its own entry.
const ownMembersCache = new Map<Function, string[]>();
function ownMembersOf(ctor: Function): string[] {
    let members = ownMembersCache.get(ctor);
    if (members == null)
        ownMembersCache.set(ctor, members = PropertyRoute.memberPaths(ctor).filter(p => !/[.\/\[\]]/.test(p)));
    return members;
}

function buildOperation(
    key: string,
    op: { operationType: OperationMetadata["operationType"] },
    entityCtor: Function,
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
    // The `[Operations].<op>` cell-operation column's eligibility, answered where the rule lives so the
    // client's locally-built token tree agrees with the server's. See OperationMetadata.canBeCellOperation.
    if (OperationLogic.isEligibleForCellOperation(op as IOperation, entityCtor)) info.canBeCellOperation = true;
    return info;
}



