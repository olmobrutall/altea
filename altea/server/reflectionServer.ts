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
}

export namespace ReflectionServer {

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
            { res: CustomType<ServerMetadata>() },
            (req, res) => {
                const culture = (req.query["culture"] as string | undefined) ?? CultureInfo.currentUICulture();
                res.json(buildMetadata(culture));
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
