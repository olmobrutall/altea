import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { getTypeInfo } from "@altea/altea/data/reflection";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { getFilterOperations } from "@altea/altea/client/FindOptions";
import { NoteWithDateEntity } from "../../data/music";

// The @fullTextIndex decorator marks its columns' FieldInfo with hasFullTextIndex (isomorphic), and
// the client offers the full-text filter operations on those tokens (Signum's FindOptions). No DB.

describe("Full-text filter operations (client)", () => {
    test("@fullTextIndex sets hasFullTextIndex on the covered fields", () => {
        const ti = getTypeInfo(NoteWithDateEntity)!;
        assert.equal(ti.fields["title"].hasFullTextIndex, true);
        assert.equal(ti.fields["text"].hasFullTextIndex, true);
        // A non-indexed column is not marked.
        assert.notEqual(ti.fields["creationDate"]?.hasFullTextIndex, true);
    });

    test("getFilterOperations offers FreeText / TsQuery on a full-text column", () => {
        const titleToken = new RootToken(NoteWithDateEntity).subToken("title", SubTokensOptionsAll)!;
        const ops = getFilterOperations(titleToken);
        for (const op of ["FreeText", "ComplexCondition", "TsQuery", "TsQuery_Plain", "TsQuery_Phrase", "TsQuery_WebSearch"])
            assert.ok(ops.includes(op as never), `expected full-text op ${op} to be offered`);
        // The ordinary string operations are still offered too.
        assert.ok(ops.includes("Contains"));
    });

    test("getFilterOperations does NOT offer full-text ops on a non-indexed column", () => {
        const dateToken = new RootToken(NoteWithDateEntity).subToken("creationDate", SubTokensOptionsAll)!;
        const ops = getFilterOperations(dateToken);
        assert.ok(!ops.includes("FreeText" as never));
        assert.ok(!ops.includes("TsQuery" as never));
    });
});
