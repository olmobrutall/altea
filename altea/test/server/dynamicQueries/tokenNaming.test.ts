import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { SubTokensOptionsAll, stripLegacyRootPrefix } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { setLegacyPropertyPaths } from "@altea/altea/data/propertyRoute";
import { tokenSequence } from "@altea/altea/client/QueryTokenString";
import "@altea/altea/server/dynamicQuery/tokenExpressions"; // registers token factories
import { AlbumEntity, NoteWithDateEntity } from "../../data/music";

// A query token's KEY is PascalCase, as Signum's is — the spelling `QueryTokenString.tokenSequence`
// (and therefore `Type.token(…)`, every `defaultColumns` entry and every `findOptions` builder) has
// always produced, and the one a Signum database's stored assets hold. Pinned here because getting it
// wrong is silent: a mis-cased key resolves through the case-insensitive fallback and only shows up as
// a token STRING that differs from the one the other framework wrote.

const O = SubTokensOptionsAll;
const album = () => new RootToken(AlbumEntity);

describe("token keys are PascalCase, like Signum's", () => {
    test("a field token takes the field's name, capitalised", () => {
        const keys = album().subTokens(O).map(t => t.key);
        for (const k of ["Id", "Name", "Year", "Author", "Label", "Songs", "ToString", "HasValue"])
            assert.ok(keys.includes(k), `missing ${k}`);
        assert.ok(!keys.includes("name"), "the camelCase field name is not a key");
    });

    test("a nested path chains them", () => {
        assert.equal(album().subToken("Label", O)!.subToken("Name", O)!.fullKey(), "Label.Name");
    });

    test("a value-member token uses Signum's PropertyInfo name, not altea's binder member", () => {
        assert.equal(album().subToken("Name", O)!.subToken("Length", O)!.fullKey(), "Name.Length");
        const dates = new RootToken(NoteWithDateEntity).subToken("CreationTime", O)!.subTokens(O).map(t => t.key);
        for (const k of ["Year", "Month", "Day", "DayOfWeek", "Hour", "Date"])
            assert.ok(dates.includes(k), `missing date part ${k}`);
    });

    test("it is the spelling the typed token builder produces", () => {
        // The whole reason for the rule: `Type.token(a => a.name)` has always PascalCased, so a token
        // BUILT by the builder and a token key had to agree — they only did on the client, whose cache
        // is case-insensitive, never on the server's lookup.
        assert.equal(tokenSequence((a: AlbumEntity) => a.label.name, true), "Label.Name");
        assert.equal(album().subToken("Label", O)!.subToken("Name", O)!.fullKey(), "Label.Name");
    });
});

describe("resolution tolerates the older spelling", () => {
    test("a camelCase key still resolves, and yields the PascalCase token", () => {
        assert.equal(album().subToken("name", O)!.fullKey(), "Name");
        assert.equal(album().subToken("label", O)!.subToken("name", O)!.fullKey(), "Label.Name");
    });

    test("an unknown key is still unknown", () => {
        assert.equal(album().subToken("nope", O), undefined);
    });
});

describe("legacy mode drops the Signum root prefix", () => {
    after(() => setLegacyPropertyPaths(false));

    test("normal mode keeps it (there is no `Entity` member to reach, so it simply fails)", () => {
        setLegacyPropertyPaths(false);
        assert.equal(stripLegacyRootPrefix(album(), "Entity.Name", O), "Entity.Name");
    });

    test("legacy mode strips it, and a bare `Entity` IS the root", () => {
        setLegacyPropertyPaths(true);
        assert.equal(stripLegacyRootPrefix(album(), "Entity.Name", O), "Name");
        assert.equal(stripLegacyRootPrefix(album(), "Entity", O), "");
    });

    test("only the LEADING segment, and only when nothing answers to it", () => {
        setLegacyPropertyPaths(true);
        assert.equal(stripLegacyRootPrefix(album(), "Name", O), "Name");
        // `Entity` deeper in the path is a member like any other — never the root.
        assert.equal(stripLegacyRootPrefix(album(), "Label.Entity", O), "Label.Entity");
    });
});
