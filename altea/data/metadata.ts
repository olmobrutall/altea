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
// `minTypeAllowed`/`maxTypeAllowed` to TypeMetadata and `propertyAllowed` & friends to FieldMetadata.
// The core neither reads nor understands those fields; it only carries them.

import type { PrimaryKey } from './entity';
// Type-only (erased at emit): data/reflection imports utils/localization, which imports THIS module, so
// a runtime import here would close a cycle.
import type { OperationType } from './reflection';
import { CultureInfo } from './utils/cultureInfo';

// Signum's `KindOfType`. altea folds Signum's "Message" / "Query" / "SymbolContainer" into one
// "Container" (a named runtime object that owns localizable members but is not a class), and its
// "Entity" splits into a persisted "Entity" and a non-persisted "Model" (EmbeddedEntity / ModelEntity).
export type KindOfType = "Entity" | "Model" | "Enum" | "Container";

// One property route's runtime facts. Keyed in `TypeMetadata.fields` by the route's
// `PropertyRoute.propertyString()` — "orderDate", "shipAddress.city", "[CorruptMixin].corrupt" — so an
// EMBEDDED type's members appear DOTTED under each owning entity, exactly as in Signum (whose
// `ReflectionServer` builds Members from `PropertyRoute.GenerateRoutes(type)`). That is also the key
// altea's property rules already use (`RulePropertyEntity.path`), so authorization is a direct lookup.
// An embedded/model type ALSO gets its own TypeMetadata entry — that one is where its translations live.
export interface FieldMetadata {
    // OMITTED when it equals the humanized member name (the client falls back to `niceMemberName`), so a
    // route-complete blob stays close in size to the old translations-only one.
    niceName?: string;
    // The database id of an enum member / symbol, so the client can build a Lite of one without a round
    // trip (Signum's `MemberInfo.id`). Only on "Enum" and "Container" (symbol) types.
    id?: PrimaryKey;
}

// A registered operation, as the client needs it (Signum's OperationInfo). Lives UNDER the type it
// targets: `OperationLogic` knows each operation's entity type explicitly (Graph options' `entityType`),
// so neither tier has to derive it from the symbol key by string surgery any more.
export interface OperationMetadata {
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
}

export interface TypeMetadata {
    kind: KindOfType;
    // Both OMITTED when they equal the humanized type name (see FieldMetadata.niceName).
    niceName?: string;
    nicePluralName?: string;
    gender?: string;
    // Whether an executable query is registered for this type AND visible to the current role (Signum's
    // `TypeInfo.queryDefined`). Replaces the old flat `queries: string[]` section.
    hasQuery?: boolean;
    fields: Record<string, FieldMetadata>;
    operations?: Record<string, OperationMetadata>;
}

// The whole blob for ONE culture and ONE role — what GET /api/reflection/metadata returns.
export interface MetadataBlob {
    culture: string;
    // Keyed by the type's registered name (the same key translation XML uses): "OrderEntity",
    // "OrderState", "OrderOperation". A Record, not an array — every consumer is a by-name lookup.
    types: Record<string, TypeMetadata>;
}

export namespace Metadata {

    // culture → type name → TypeMetadata. On the SERVER these are the parsed translation files (many
    // cultures loaded at boot, one dumped per request); on the CLIENT it holds the single applied blob.
    // Either way the lookup path below is identical.
    //
    // Holds only the CULTURE-dependent half. The ROLE-dependent half (min/maxTypeAllowed,
    // propertyAllowed) is stamped into the outgoing blob per request by ReflectionServer's
    // MetadataFilter and MUST NOT be written back here — the server serves concurrent roles.
    const store = new Map<string, Map<string, TypeMetadata>>();

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
            for (const [path, fm] of Object.entries(tm.fields))
                existing.fields[path] = { ...existing.fields[path], ...fm };
            if (tm.operations != null)
                Object.assign(existing.operations ??= {}, tm.operations);
        }
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

    // Client boot: adopt the blob's culture as the process default and merge its types in.
    export function apply(blob: MetadataBlob): void {
        CultureInfo.setDefaultCulture(blob.culture);
        CultureInfo.setDefaultUICulture(blob.culture);
        replace(blob.culture, blob.types);
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
     * The FieldMetadata for a property route in the current UI culture, or undefined. `path` is a
     * `PropertyRoute.propertyString()`. Translation files written for Signum key members by the
     * PascalCase C# name, so a camelCase altea path is probed capitalised as a fallback.
     */
    export function tryField(typeName: string, path: string): FieldMetadata | undefined {
        const fields = tryType(typeName)?.fields;
        if (fields == null) return undefined;
        return fields[path] ?? fields[capitalizePath(path)];
    }

    /** The OperationMetadata for an operation key on a type in the current UI culture, or undefined. */
    export function tryOperation(typeName: string, operationKey: string): OperationMetadata | undefined {
        return tryType(typeName)?.operations?.[operationKey];
    }

    // The application's supported cultures, when something authoritative knows them. CultureInfoLogic
    // installs this once its table is in play; until then the loaded translations are the best available
    // answer. Kept as a seam so the isomorphic data layer needn't know about a server table.
    let cultureCatalogue: (() => string[]) | undefined;
    export function setCultureCatalogue(fn: (() => string[]) | undefined): void { cultureCatalogue = fn; }

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
        store.clear();
    }
}

// Capitalize each dot/bracket-separated segment of a property path: "shipAddress.city" →
// "ShipAddress.City". Signum's XML uses the PascalCase C# member names; altea's routes are camelCase.
function capitalizePath(path: string): string {
    return path.replace(/(^|[.\]])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

function cloneType(tm: TypeMetadata): TypeMetadata {
    const clone: TypeMetadata = { ...tm, fields: {} };
    for (const [path, fm] of Object.entries(tm.fields))
        clone.fields[path] = { ...fm };
    if (tm.operations != null) {
        clone.operations = {};
        for (const [key, om] of Object.entries(tm.operations))
            clone.operations[key] = { ...om };
    }
    return clone;
}
