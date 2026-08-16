// The reflection metadata HTTP API (Signum's ReflectionServer.cs / the client's ReflectionServer.ts).
// altea has NO runtime reflection blob for the entity SHAPE (that is emitted at compile time by the
// quote-transformer onto each constructor's TypeInfo/FieldInfo). This endpoint ships only the pieces
// that are runtime- / culture- / user-dependent and therefore cannot be baked into the shared entity
// classes:
//   - translations  — the LocalizedTypes for the requested UI culture (client → addLocalizedTypes)
//   - queries        — the keys of the registered executable queries (client Finder "queryDefined")
//   - operations     — an OperationInfo per registered operation (client Operations registry)
//
// Deliberately NOT here (they are static, identical for every user/culture, and needed BEFORE any
// entity is deserialized, so they live in the shared entity layer / EntityDeclarations, run by both
// tiers at startup): mixin registrations, lite-model constructors, implementedBy overrides.
// Authorization is a future, per-user overlay (a separate endpoint), not part of this blob.

import { Localization } from "../data/utils/localization";
import { CultureInfo } from "../data/utils/cultureInfo";
type LocalizedTypes = Localization.LocalizedTypes;
import { getKey } from "../data/dynamicQuery/queryUtils";
import { QueryLogic } from "./dynamicQuery/queryLogic";
import { OperationLogic } from "./operationLogic";
import type { OperationType } from "./operation";
import { WebBuilder, CustomType } from "./webApi";
import { resolveType } from "../data/registration";
import { TypeLogic } from "./typeLogic";
import type { TypeEntity } from "../data/typeEntity";

// A registered operation as the client needs it (Signum's OperationInfo, trimmed to altea's model).
// canBeNew/canBeModified/resultIsSaved are present only for the operation kinds that carry them.
export interface OperationInfo {
    key: string;
    operationType: OperationType;
    canBeNew?: boolean;
    canBeModified?: boolean;
    resultIsSaved?: boolean;
    // Whether the operation gates on the button state (an IEntityOperation with onCanExecute).
    hasCanExecute: boolean;
    // Whether the operation constrains entity state (from/to states via a getState selector).
    hasStates: boolean;
}

// The runtime/culture-dependent metadata the client fetches once at boot for a given UI culture.
export interface ServerMetadata {
    culture: string;
    translations: LocalizedTypes;
    queries: string[];
    operations: Record<string, OperationInfo>;
    // OPAQUE per-type payload an authorization MetadataFilter may attach (cleanName → a numeric allowance);
    // buildMetadata leaves it undefined and the core never interprets it. The auth client projects it onto
    // its own interface-expanded TypeInfo fields. Only restricted types need appear.
    typeAllowed?: Record<string, number>;
}

export namespace ReflectionServer {

    // Per-request, per-user overlay hook (Signum's ReflectionServer.TypeExtension / QueryExtension /
    // OperationExtension). An auth module installs it via setMetadataFilter; it runs inside the request's
    // user scope so it can role-filter the blob (omit types/queries/operations the current role can't
    // access). Undefined → the blob ships unfiltered (no auth module).
    export type MetadataFilter = (meta: ServerMetadata) => ServerMetadata | Promise<ServerMetadata>;
    let _metadataFilter: MetadataFilter | undefined;
    export function setMetadataFilter(fn: MetadataFilter | undefined): void { _metadataFilter = fn; }
    export function getMetadataFilter(): MetadataFilter | undefined { return _metadataFilter; }

    // Assemble the blob for a UI culture. Every section is either culture-independent (queries,
    // operations) or dumped for the explicit locale (translations), so this needs no current-culture
    // context — callable from a plain unit test as well as inside a request.
    export function buildMetadata(culture: string): ServerMetadata {
        return {
            culture,
            translations: Localization.getLocalizedTypes(culture),
            queries: QueryLogic.queries.getQueryNames().map(getKey),
            operations: buildOperations(),
        };
    }

    export function start(ws: WebBuilder): void {
        // GET /api/reflection/metadata?culture=xx — plain JSON (no entities), so res.json (not the
        // entity Serializer). Culture defaults to the process/context UI culture.
        ws.get("/api/reflection/metadata",
            // allowAnonymous: the client fetches this at boot to render (among other things) the login
            // page, before any user is authenticated. The metadata itself is role-filtered once the
            // authorization engine lands.
            { res: CustomType<ServerMetadata>(), allowAnonymous: true },
            async (req, res) => {
                const culture = (req.query["culture"] as string | undefined) ?? CultureInfo.currentUICulture();
                let meta = buildMetadata(culture);
                if (_metadataFilter != null)
                    meta = await _metadataFilter(meta);
                res.json(meta);
            });

        // GET /api/reflection/typeEntity/:typeName — the persisted TypeEntity row for a (clean) type name
        // (Signum's ReflectionController.GetTypeEntity → `TypeLogic.TryGetType(name)?.ToTypeEntity()`).
        // altea: resolveType maps the clean name → ctor, then TypeLogic's warm type↔id↔entity caches yield
        // the TypeEntity. Returns JSON null when the name is unknown/unregistered. Entity-serialized via
        // jsonTyped so the client's ajaxGet revives a real TypeEntity. NOT anonymous (a logged-in lookup).
        ws.get("/api/reflection/typeEntity/:typeName",
            { params: CustomType<{ typeName: string }>(), res: CustomType<TypeEntity | null>() },
            async (req, res) => {
                const ctor = resolveType(req.params.typeName);
                let te: TypeEntity | undefined;
                if (ctor != null) {
                    try {
                        te = TypeLogic.idToEntity(TypeLogic.typeToId(ctor));
                    } catch {
                        te = undefined; // type not registered in the DB type table
                    }
                }
                res.jsonTyped(te ?? null);
            });
    }
}

function buildOperations(): Record<string, OperationInfo> {
    const result: Record<string, OperationInfo> = {};
    for (const symbol of OperationLogic.registeredOperations()) {
        const op = OperationLogic.tryFindOperation(symbol);
        if (op == null) continue;
        const anyOp = op as unknown as Record<string, unknown>;
        const info: OperationInfo = {
            key: symbol.key,
            operationType: op.operationType,
            hasCanExecute: "onCanExecute" in op,
            hasStates: anyOp["getState"] != null,
        };
        if ("canBeNew" in op) info.canBeNew = anyOp["canBeNew"] as boolean;
        if ("canBeModified" in op) info.canBeModified = anyOp["canBeModified"] as boolean;
        if ("resultIsSaved" in op) info.resultIsSaved = anyOp["resultIsSaved"] as boolean;
        result[symbol.key] = info;
    }
    return result;
}
