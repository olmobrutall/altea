import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OperationSymbol } from "@altea/altea/entities/operations";
import { declaredSymbolsForType } from "@altea/altea/entities/reflection";
import { ArtistOperation } from "../entities/testOperations";

// Phase 1 (Symbol / init) — pure in-memory, no DB. Verifies the transformer +
// init() runtime produce a real OperationSymbol keyed "<Container>.<member>".
describe("Symbol / init()", () => {
    test("init() builds an OperationSymbol with the <Container>.<member> key", () => {
        assert.equal(ArtistOperation.Save.key, "ArtistOperation.Save");
        assert.equal(ArtistOperation.Delete.key, "ArtistOperation.Delete");
        assert.equal(ArtistOperation.Create.key, "ArtistOperation.Create");
    });

    test("the declared symbol is a real (non-new) OperationSymbol entity", () => {
        assert.ok(ArtistOperation.Save instanceof OperationSymbol);
        assert.equal(ArtistOperation.Save.isNew, false);
    });

    test("declaredSymbolsForType(OperationSymbol) enumerates the declared operations", () => {
        const keys = declaredSymbolsForType(OperationSymbol).map(s => s.key);
        assert.ok(keys.includes("ArtistOperation.Save"));
        assert.ok(keys.includes("ArtistOperation.Delete"));
        assert.ok(keys.includes("ArtistOperation.Create"));
    });
});
