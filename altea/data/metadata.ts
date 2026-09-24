// The RUNTIME reflection metadata: everything about a type that depends on the current CULTURE or the
// current ROLE, and therefore cannot be baked into the compile-time `TypeInfo` / `FieldInfo` that the
// quote-transformer stamps onto each constructor.
//
// NAMING (an altea divergence from Signum, deliberate): Signum has one `TypeInfo` / `MemberInfo` /
// `OperationInfo` family and ships it wholesale to the client. altea splits the two halves:
//
//   *Info      (data/reflection)  — STABLE for every user and every culture: types, units, formats,
//                                   validators, implementations. Emitted at compile time.
//   *Metadata  (this file)        — PER-CULTURE (nice names, gender) and PER-ROLE (allowances).
//                                   Assembled per request by the server, shipped as ONE blob.
//
// Structurally this mirrors Signum: ONE `TypeMetadata` per type carrying every runtime fact about it,
// instead of the four parallel, differently-keyed maps the reflection blob used to ship (translations
// keyed by type, queries as a flat name list, operations keyed by operation key, and an opaque
// `typeAllowed` map bolted on by the authorization module).
//
// EXTENSIBILITY: an extension module widens these interfaces with `declare module` — altea-auth adds
// `maxTypeAllowed` to TypeMetadata and `propertyAllowed` to FieldMetadata, and REMOVES the types the
// current role may not read. The core neither reads nor understands those fields; it only carries them.
// It does, however, guarantee the thing that removal relies on: an entry for EVERY type it knows, even an
// empty one, so that a missing entry can only have come from the filter.

import type { PrimaryKey } from './entity';
// Type-only (erased at emit): data/reflection imports utils/localization, which imports THIS module, so
// a runtime import here would close a cycle.
import type { OperationType } from './reflection';
import type { ServerTokenJson } from './dynamicQuery/tokenSerializer';
import { CultureInfo } from './utils/cultureInfo';
import { Clock, TimeZoneMode } from './utils/clock';

// Signum's `KindOfType`. altea folds Signum's "Message" / "Query" / "SymbolContainer" into one
// "Container" (a named runtime object that owns localizable members but is not a class), and its
// "Entity" splits into a persisted "Entity" and a non-persisted "Model" (EmbeddedEntity / ModelEntity).
export type KindOfType = "Entity" | "Model" | "Enum" | "Container";

/**
 * One MEMBER of the type that DECLARES it. Keyed in `TypeMetadata.fields` by the bare member name —
 * "city", "orderDate", "Saved" — never by a path, because the question a member answers does not depend
 * on how the member was reached: `AddressEmbedded.city` is "Stadt" whether the UI got there as
 * `Order.shipAddress.city` or by rendering an AddressEmbedded on its own. That is exactly the pair
 * `FieldInfo.niceToString()` asks with (`declaringType.name`, `name`), and it is why an embedded, a
 * `@part` and a mixin each carry their own members here rather than being restated under every owner.
 *
 * The other half — what the current ROLE may do with a member REACHED BY A PARTICULAR PATH — is the
 * opposite kind of fact and lives in `TypeMetadata.routes`. See there.
 */
export interface FieldMetadata {
    // OMITTED when it equals the humanized member name (the client falls back to `niceMemberName`), so a
    // type that translates nothing carries no entry at all.
    niceName?: string;
    // The database id of an enum member / symbol, so the client can build a Lite of one without a round
    // trip (Signum's `MemberInfo.id`). Only on "Enum" and "Container" (symbol) types.
    id?: PrimaryKey;
}

/**
 * One PROPERTY ROUTE of a root entity — a member addressed by the whole path that reaches it, keyed by
 * `PropertyRoute.propertyString()` rooted at a persisted Entity: "orderDate", "shipAddress.city",
 * "details/quantity", "[CorruptMixin].corrupt". The same key `RulePropertyEntity.path` stores, so an
 * authorization lookup is a direct hit.
 *
 * DISTINCT FROM `fields`, and deliberately so — the two answer different questions and disagree on both
 * the type and the key. For `Order.shipAddress.city`:
 *
 *      fields  on AddressEmbedded, key "city"                 — what is this member called
 *      routes  on OrderEntity,     key "shipAddress.city"     — what may the role do with it HERE
 *
 * They coincide only for a direct member of an entity, which is what made one shared record look
 * workable. Every caller already holds the right pair: the Lines layer's `ownerRootedRoute` climbs the
 * TypeContext chain to rebuild (root entity, path) precisely because a re-rooted embedded has lost it,
 * while `FieldInfo.niceToString` never needs to climb at all.
 *
 * Core declares no member of its own: an authorization module widens this with `propertyAllowed`.
 * Present only where something has an answer, so most types carry no `routes` at all.
 */
export interface RouteMetadata {
}

// A registered operation, as the client needs it (Signum's OperationInfo). Lives UNDER the type it
// targets: `OperationLogic` knows each operation's entity type explicitly (Graph options' `entityType`),
// so neither tier has to derive it from the symbol key by string surgery any more.
export interface OperationMetadata {
    // ABSENT ON THE WIRE — it is already the key of the `TypeMetadata.operations` record that holds this
    // value, and saying it twice cost ~40 bytes an entry. The server strips it as it serialises and the
    // client stamps it back in `fromWire`, so every reader still sees a complete OperationMetadata
    // and the field stays required. The one rule: nothing may read `.key` off a blob that has not been
    // through `fromWire`.
    key: string;
    // Resolved server-side from the operation's CONTAINER translation ("OrderOperation" + "Ship"), so the
    // client needs no second lookup.
    niceName: string;
    operationType: OperationType;
    canBeNew?: boolean;
    canBeModified?: boolean;
    resultIsSaved?: boolean;
    // Whether the operation gates on button state (an IEntityOperation with onCanExecute).
    hasCanExecute?: boolean;
    // Whether the operation constrains entity state (from/to states via a getState selector).
    hasStates?: boolean;
    // Signum's server-side CanExecute EXPRESSION (evaluated over lites for a contextual menu, without
    // retrieving each entity). altea has no such expression yet, so the server never sets it and the
    // contextual-operations layer takes its "retrieve first" path — the pre-existing behaviour.
    hasCanExecuteExpression?: boolean;
    // Signum's ForReadonlyEntity: the operation may run on an entity the role can only read. Likewise not
    // set by altea's builder yet (the nearest declared concept is Graph's `avoidImplicitSave`).
    forReadonlyEntity?: boolean;
    /**
     * Whether this operation may be surfaced as a search-result COLUMN — a button per row, backed by the
     * `[Operations].<op>` query token (`OperationLogic.isEligibleForCellOperation`).
     *
     * ALTEA-ONLY, and it exists because the two frameworks build token trees in different places: Signum's
     * client asks the SERVER for an entity token's sub-tokens, so its `GetEligibleTypeOperations` seam is
     * consulted server-side only; altea's client builds them from this blob. Shipping the ANSWER (rather
     * than the `canExecute` internals it is computed from) keeps the two tiers from drifting, and the blob
     * already carries only the operations the role may see — so the client's list is authorized for free.
     */
    canBeCellOperation?: boolean;
}

/**
 * A registered EXPRESSION of this type, in the form the client rebuilds a token from (a serialized
 * server-only token). This is the ONLY way the client learns of one.
 *
 * Keyed by extension key in `TypeMetadata.extensions`, and `key` is stamped back on apply exactly as
 * `OperationMetadata.key` is. An expression is registered against a TYPE, not a query, so it belongs in
 * the per-type blob the client already has rather than in a request per token of that type.
 *
 * Parameterized extensions — Signum's dictionary-style access with dynamic keys — cannot be enumerated
 * into a blob, so they are not supported on the client. Nothing in altea declares one.
 */
export type ExtensionMetadata = ServerTokenJson;

export interface TypeMetadata {
    kind: KindOfType;
    // Both OMITTED when they equal the humanized type name (see FieldMetadata.niceName).
    niceName?: string;
    nicePluralName?: string;
    gender?: string;
    // Whether an executable query is registered for this type AND visible to the current role (Signum's
    // `TypeInfo.queryDefined`). Replaces the old flat `queries: string[]` section.
    hasQuery?: boolean;
    /**
     * Whether a CONSTRUCTOR operation is registered for this type at all — Signum's
     * `TypeInfo.hasConstructorOperation`, and unlike everything else here it is NOT per-role: it is read
     * before authorization, precisely so the client can tell "this type has no Constructor" apart from
     * "it has one the role may not run". `operations` below carries only what the role may see, so
     * without this flag the two are indistinguishable — and a Part row, which has no Constructor of its
     * own but INHERITS `Entity`'s ConstructFroms (CreateAlertFromEntity, CreateNoteFromEntity), looks
     * like the second case and stops being creatable in every line that offers it.
     */
    hasConstructorOperation?: boolean;
    /** This type's OWN members, by bare member name. See {@link FieldMetadata}. */
    fields: Record<string, FieldMetadata>;
    /**
     * Property ROUTES rooted at this type, by `PropertyRoute.propertyString()`. Only a persisted Entity
     * ever has them, and only where a route has something to say. See {@link RouteMetadata}.
     */
    routes?: Record<string, RouteMetadata>;
    operations?: Record<string, OperationMetadata>;
    /** Registered expressions DECLARED on this type; a subtype's tokens inherit them by walking the chain. */
    extensions?: Record<string, ExtensionMetadata>;
}

// The whole blob for ONE culture and ONE role — the MODEL both tiers hold in memory.
//
// A type is in `types` exactly when the current role may READ it. An ABSENT entry means the opposite of
// what it once did: no access at all (or no such type). That is why a type with nothing else to say
// still ships as a bare `{ kind }` — the entry IS the permission, so it cannot be squeezed out.
export type TimeZoneModeName = keyof typeof TimeZoneMode;

export interface MetadataBlob {
    culture: string;
    /** The server's `Clock.mode`, which the client adopts: it decides whether a datetime is shown in the
     *  viewer's zone (see Clock.toUserInterface). Optional only so a hand-built blob (a test) may omit it. */
    timeZoneMode?: TimeZoneModeName;
    // Keyed by the type's registered name (the same key translation XML uses): "OrderEntity",
    // "OrderState", "OrderOperation". A Record, not an array — every consumer is a by-name lookup.
    types: Record<string, TypeMetadata>;
}

// ---- The WIRE form ---------------------------------------------------------------------------------
//
// What GET /api/reflection/metadata actually returns: the model above with its redundancies squeezed out
// at the edge (ReflectionServer's `toWire`) and put back on arrival (`Metadata.fromWire`), so that no
// READER on either tier ever has to know about the compact shape.
//
//   - a field whose only fact is its label IS the label ("orderDate": "Fecha"), not an object wrapping
//     one key — 13 bytes an entry, and labels are most of the blob;
//   - `fields` is absent when it is empty, rather than `"fields":{}` on every type that declares none;
//   - an operation's `key` is absent, because it is already the record key that holds it.
//
// Each is a pure encoding: `fromWire` reconstructs the model exactly.

/** A field with a label and nothing else, as that label. */
export type FieldMetadataWire = string | FieldMetadata;

export type TypeMetadataWire = Omit<TypeMetadata, "fields"> & { fields?: Record<string, FieldMetadataWire> };

export interface MetadataBlobWire {
    culture: string;
    timeZoneMode?: TimeZoneModeName;
    types: Record<string, TypeMetadataWire>;
}

export namespace Metadata {

    // culture → type name → TypeMetadata. On the SERVER these are the parsed translation files (many
    // cultures loaded at boot, one dumped per request); on the CLIENT it holds the single applied blob.
    // Either way the lookup path below is identical.
    //
    // Holds only the CULTURE-dependent half — which, now that the two are separate records, is very
    // nearly "the `fields` of each type". The ROLE-dependent half (maxTypeAllowed, and the whole `routes`
    // record) is stamped into the outgoing blob per request by ReflectionServer's MetadataFilter and MUST
    // NOT be written back here — the server serves concurrent roles.
    const store = new Map<string, Map<string, TypeMetadata>>();

    /**
     * Fired after a culture's stored translations change — at boot as each file loads, and again whenever
     * the translation editor saves and the culture is re-read.
     *
     * It exists so that a cache BUILT from this store cannot silently outlive it: the server's metadata
     * blob is assembled per culture and memoised, and before this hook "the translations never change at
     * runtime" was an assumption held together by the fact that nothing happened to call `merge` twice.
     * Anything that derives from the store should subscribe rather than rely on that.
     */
    export const onChanged: ((culture: string) => void)[] = [];

    // Merge TypeMetadata into a culture (later entries override earlier keys, per key not per type).
    // Deep-copies so a caller's object never becomes shared mutable state.
    export function merge(culture: string, types: Record<string, TypeMetadata>): void {
        let byType = store.get(culture);
        if (byType == null) { byType = new Map(); store.set(culture, byType); }
        for (const [name, tm] of Object.entries(types)) {
            const existing = byType.get(name);
            if (existing == null) {
                byType.set(name, cloneType(tm));
                continue;
            }
            if (tm.niceName != null) existing.niceName = tm.niceName;
            if (tm.nicePluralName != null) existing.nicePluralName = tm.nicePluralName;
            if (tm.gender != null) existing.gender = tm.gender;
            if (tm.hasQuery != null) existing.hasQuery = tm.hasQuery;
            for (const [member, fm] of Object.entries(tm.fields))
                existing.fields[member] = { ...existing.fields[member], ...fm };
            if (tm.routes != null)
                for (const [path, rm] of Object.entries(tm.routes))
                    (existing.routes ??= {})[path] = { ...existing.routes?.[path], ...rm };
            if (tm.operations != null)
                Object.assign(existing.operations ??= {}, tm.operations);
        }
        for (const h of onChanged)
            h(culture);
    }

    // Every TypeMetadata loaded for a culture, deep-copied (the server folds this into the wire blob).
    // Empty when nothing is loaded — callers then fall back to humanizing the identifier.
    export function forCulture(culture: string): Record<string, TypeMetadata> {
        const result: Record<string, TypeMetadata> = {};
        const byType = store.get(culture);
        if (byType != null)
            for (const [name, tm] of byType)
                result[name] = cloneType(tm);
        return result;
    }

    /**
     * Put back everything the wire form leaves out — a `string` field expanded to a `{ niceName }`, an
     * absent `fields` back to an empty record, each operation's own `key` (which is the record key that
     * holds it, see `OperationMetadata.key`) — so that from here on there is only ONE shape to read.
     *
     * Total and non-mutating: a blob that never crossed the wire (a server-built one, a test's literal)
     * is already in the model form and passes through as an equal copy.
     *
     * Called from `apply`, so every path that installs a blob is covered by construction rather than by
     * each caller remembering.
     */
    export function fromWire(blob: MetadataBlobWire): MetadataBlob {
        const types: Record<string, TypeMetadata> = {};
        for (const [name, tw] of Object.entries(blob.types)) {
            const fields: Record<string, FieldMetadata> = {};
            for (const [member, fw] of Object.entries(tw.fields ?? {}))
                fields[member] = typeof fw === "string" ? { niceName: fw } : { ...fw };
            const tm: TypeMetadata = { ...tw, fields };
            if (tw.routes != null) {
                tm.routes = {};
                for (const [path, rm] of Object.entries(tw.routes))
                    tm.routes[path] = { ...rm };
            }
            if (tw.operations != null) {
                tm.operations = {};
                for (const [key, om] of Object.entries(tw.operations))
                    tm.operations[key] = { ...om, key };
            }
            types[name] = tm;
        }
        return { culture: blob.culture, timeZoneMode: blob.timeZoneMode, types };
    }

    // Whether a blob has ever been APPLIED here. The distinction that needs it: a type with no
    // `extensions` entry means "this type has no registered expressions", but only once there is a blob
    // to have read — before that it means nothing at all, and a token picker that ran that early would
    // otherwise conclude there are none rather than asking the server. Lives on the store because that is
    // what the question is about; asking TokenCache instead would close an import cycle through
    // ReflectionClient.
    let appliedAny = false;
    export function isApplied(): boolean { return appliedAny; }

    /**
     * Client boot: adopt the blob's culture as the process default and install its types, replacing
     * whatever that culture held. Takes the WIRE form and answers the MODEL form it installed — every
     * caller that wants to read the blob it just applied (symbol ids, the query registry, an extension's
     * hook) should read THAT, not the compact thing that came off the socket.
     */
    export function apply(blob: MetadataBlobWire): MetadataBlob {
        const model = fromWire(blob);
        CultureInfo.setDefaultCulture(model.culture);
        CultureInfo.setDefaultUICulture(model.culture);
        if (model.timeZoneMode != null)
            Clock.mode = TimeZoneMode[model.timeZoneMode];
        replace(model.culture, model.types);
        appliedAny = true;
        return model;
    }

    // Replace (not merge) a culture's types. Used on the client, where a re-login as a different role
    // must not leave the previous role's allowances behind.
    export function replace(culture: string, types: Record<string, TypeMetadata>): void {
        store.delete(culture);
        merge(culture, types);
    }

    /** The TypeMetadata registered for a type NAME in the current UI culture, or undefined. */
    export function tryType(typeName: string): TypeMetadata | undefined {
        return store.get(CultureInfo.currentUICulture())?.get(typeName);
    }

    /**
     * The FieldMetadata for one MEMBER of the type that DECLARES it, in the current UI culture — the
     * (declaring type, member) pair `FieldInfo.niceToString()` holds, never a path. Translation files
     * written for Signum key members by the PascalCase C# name, so a camelCase altea member is probed
     * capitalised as a fallback.
     */
    export function tryField(typeName: string, member: string): FieldMetadata | undefined {
        const fields = tryType(typeName)?.fields;
        if (fields == null) return undefined;
        return fields[member] ?? fields[member.charAt(0).toUpperCase() + member.slice(1)];
    }

    /**
     * The RouteMetadata for one property ROUTE, in the current UI culture — `rootTypeName` is a persisted
     * entity and `path` a `PropertyRoute.propertyString()` rooted at it. The counterpart of `tryField`,
     * and the deliberate opposite of it: this one IS about the way the member was reached.
     *
     * No capitalisation fallback. A route key is not a translation-file name — it is what
     * `RulePropertyEntity.path` stores, written by the same `propertyString()` on both tiers.
     */
    export function tryRoute(rootTypeName: string, path: string): RouteMetadata | undefined {
        return tryType(rootTypeName)?.routes?.[path];
    }

    /** The OperationMetadata for an operation key on a type in the current UI culture, or undefined. */
    export function tryOperation(typeName: string, operationKey: string): OperationMetadata | undefined {
        return tryType(typeName)?.operations?.[operationKey];
    }

    // The application's supported cultures, when something authoritative knows them. CultureInfoLogic
    // installs this once its table is in play; until then the loaded translations are the best available
    // answer. Kept as a seam so the isomorphic data layer needn't know about a server table.
    // May answer `undefined` — the source is a cache that can be cold, and falling back to the loaded
    // translations is better than answering with a stale list somebody kept on the side.
    let cultureCatalogue: (() => string[] | undefined) | undefined;
    export function setCultureCatalogue(fn: (() => string[] | undefined) | undefined): void { cultureCatalogue = fn; }

    /**
     * The cultures the application offers. With a `CultureInfoEntity` table (Signum's model) that is what
     * the table says — so an app can support a culture it has not translated yet, and can withhold one it
     * has. Without it, the locales whose translation files were found at boot are the best guess.
     * Sorted, so the picker order is stable.
     */
    export function cultures(): string[] {
        return (cultureCatalogue?.() ?? [...store.keys()]).sort();
    }

    /** Drop everything loaded (tests / a culture reload). */
    export function clear(): void {
        const cultures = [...store.keys()];
        store.clear();
        // Announced like any other change, so a derived cache cannot survive a wipe.
        for (const c of cultures)
            for (const h of onChanged)
                h(c);
    }
}

function cloneType(tm: TypeMetadata): TypeMetadata {
    const clone: TypeMetadata = { ...tm, fields: {} };
    for (const [member, fm] of Object.entries(tm.fields))
        clone.fields[member] = { ...fm };
    if (tm.routes != null) {
        clone.routes = {};
        for (const [path, rm] of Object.entries(tm.routes))
            clone.routes[path] = { ...rm };
    }
    if (tm.operations != null) {
        clone.operations = {};
        for (const [key, om] of Object.entries(tm.operations))
            clone.operations[key] = { ...om };
    }
    return clone;
}
