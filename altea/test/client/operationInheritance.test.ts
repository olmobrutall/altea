import { test, describe, beforeEach } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { Metadata, type MetadataBlob } from "@altea/altea/data/metadata";
import { getOperationInfos, tryGetOperationInfo, hasConstructorOperation } from "@altea/altea/client/Reflection";
import { ArtistEntity, BandEntity } from "../data/music";

// The other half of "an inherited operation is shipped once": the blob carries it on the type that
// DECLARES it, and the client resolves the inheritance by walking the real prototype chain. Entities are
// real classes on the client, so `Object.getPrototypeOf(ctor)` is the same relation the server's
// `operationsForType` tests with `ctor.prototype instanceof owner` — and it costs no wire bytes.
//
// Everything here is built by hand: it is the READING rule that is under test, not how a server fills
// the blob in (reflectionServer.test.ts covers that end).

const op = (niceName: string, operationType: "Execute" | "Constructor" | "ConstructorFrom") =>
    ({ key: "", niceName, operationType }) as never;

function applyBlob(types: MetadataBlob["types"]): void {
    Metadata.apply({ culture: "en", types });
}

describe("operation inheritance on the client", () => {

    beforeEach(() => {
        applyBlob({
            // Declared on the shared base, exactly as AlertOperation.CreateAlertFromEntity is.
            Entity: { kind: "Entity", fields: {}, operations: { "AlertOperation.CreateAlertFromEntity": op("Create alert", "ConstructorFrom") } },
            ArtistEntity: { kind: "Entity", fields: {}, operations: { "ArtistOperation.Save": op("Save", "Execute") } },
            // No operations of its own at all — everything it can run is inherited.
            BandEntity: { kind: "Entity", fields: {} },
        });
    });

    test("a subclass sees the operations its base declares, plus its own", () => {
        const keys = getOperationInfos(ArtistEntity).map(oi => oi.key);
        assert.deepEqual(keys.sort(), ["AlertOperation.CreateAlertFromEntity", "ArtistOperation.Save"]);
    });

    test("a type with no operations entry of its own still inherits", () => {
        assert.deepEqual(getOperationInfos(BandEntity).map(oi => oi.key), ["AlertOperation.CreateAlertFromEntity"]);
    });

    test("tryGetOperationInfo finds an inherited one", () => {
        assert.equal(tryGetOperationInfo("AlertOperation.CreateAlertFromEntity", BandEntity)?.niceName, "Create alert");
        assert.equal(tryGetOperationInfo("ArtistOperation.Save", BandEntity), undefined, "not inherited sideways");
    });

    // The walk goes down-up and takes the first answer, so a subtype that declares the same key REPLACES
    // the base's rather than appearing twice beside it.
    test("a subtype's own entry overrides the base's for the same key", () => {
        applyBlob({
            Entity: { kind: "Entity", fields: {}, operations: { "Shared.Op": op("from base", "Execute") } },
            ArtistEntity: { kind: "Entity", fields: {}, operations: { "Shared.Op": op("from subtype", "Execute") } },
        });

        const infos = getOperationInfos(ArtistEntity);
        assert.equal(infos.length, 1, "not listed twice");
        assert.equal(infos[0]!.niceName, "from subtype");
        assert.equal(tryGetOperationInfo("Shared.Op", ArtistEntity)?.niceName, "from subtype");
    });

    // `key` is not on the wire — it is the record key — so Metadata.apply stamps it back. Everything that
    // reads `.key` off an OperationMetadata (every operation button, every API call) depends on this.
    test("Metadata.apply stamps each operation's own key back", () => {
        assert.equal(tryGetOperationInfo("ArtistOperation.Save", ArtistEntity)?.key, "ArtistOperation.Save");
    });

    // hasConstructorOperation is NOT inherited through this walk on purpose: it stays a per-type flag the
    // server computes, because it must answer before the per-role filter drops operations. But a base's
    // Constructor still reaches a subtype through the operations themselves.
    test("a Constructor declared on the base is visible from the subtype", () => {
        applyBlob({
            Entity: { kind: "Entity", fields: {}, operations: { "Shared.Create": op("Create", "Constructor") } },
            ArtistEntity: { kind: "Entity", fields: {} },
        });
        assert.equal(hasConstructorOperation(ArtistEntity), true);
    });
});
