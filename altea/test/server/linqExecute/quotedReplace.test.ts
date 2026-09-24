import { test, beforeAll, afterAll, describe } from "vitest";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import "@altea/altea/data/globals";
import { withQuoted } from "@altea/altea/data/decorators";
import { hasDb, start } from "../setup";
import { ArtistEntity } from "../../data/music";

// Signum's `As.ReplaceExpression`: an application replaces a framework type's @quoted member (ReNew
// makes UserEntity.toString "FirstName LastName"). In altea that is assigning a new `withQuoted` function
// to the prototype — the in-memory body and the query expression are both read off the prototype when
// they are used, so the replacement has to reach every place a quoted member is consumed.

describe.skipIf(!hasDb)("replacing a @quoted member", () => {
    const original = ArtistEntity.prototype.toString;

    beforeAll(async () => {
        await start();
        ArtistEntity.prototype.toString = withQuoted(function (this: ArtistEntity): string {
            return "Artist " + this.name;
        });
    });

    afterAll(() => {
        ArtistEntity.prototype.toString = original;
    });

    test("in memory", async () => {
        const artist = await table(ArtistEntity).filter(a => a.name == "Michael Jackson").single() as ArtistEntity;
        assert.equal(artist.toString(), "Artist Michael Jackson");
    });

    test("projected and filtered in SQL", async () => {
        const q = table(ArtistEntity)
            .filter(a => a.toString() == "Artist Michael Jackson")
            .map(a => a.toString());
        assert.match(q.queryTextForDebug(), /Artist /);
        assert.deepEqual(await q.toArray(), ["Artist Michael Jackson"]);
    });

    test("the toStr of a lite a query builds", async () => {
        const lites = await table(ArtistEntity).filter(a => a.name == "Michael Jackson").map(a => a.toLite()).toArray();
        assert.equal(lites.length, 1);
        assert.equal(lites[0].toString(), "Artist Michael Jackson");
    });

    test("the toStr of a lite built in memory", async () => {
        const artist = await table(ArtistEntity).filter(a => a.name == "Michael Jackson").single() as ArtistEntity;
        assert.equal(artist.toLite().toString(), "Artist Michael Jackson");
    });
});
