import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { retrieve, retrieveList, retrieveFromListOfLite } from "@altea/altea/logic/Database";
import { Connector } from "@altea/altea/logic/connection/connector";
import { Entity } from "@altea/altea/entities/entity";
import { exploreModifiables } from "@altea/altea/logic/graphExplorer";
import { isModifiedSelf } from "@altea/altea/entities/changes";
import { hasDb, start } from "./setup";
import {
    CountryEntity, GrammyAwardEntity, LabelEntity,
    NoteWithDateEntity, ArtistEntity, AlbumEntity, BandEntity,
} from "../entities/music";

// Port of Signum.Test/LinqProvider/RetriverTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)            .ToList()/.ToArray() → await .toArray()
//   .OrderBy(...)        → .orderBy(...)        .First()             → await .first()
//   a.ToLite()           → a.toLite()          a.Friends.Count      → a.friends.length
// These are full entity-materialization tests: they become real once the
// translator lands, so they're written live where the API exists. Terminals are
// async (the connector is async-only). Live execution is gated on ALTEA_TEST_DB;
// without it the suite is skipped but still compiles.
//
// Port of Signum's AssertRetrieved<T> (RetriverTest.cs): explore the whole graph reachable
// from the retrieved roots (GraphExplorer.FromRoots → altea's `exploreModifiables`, which
// follows references, fat lites, embeddeds and MList elements), and fail if any reachable
// node is a still-unretrieved stub — a graph-modified Entity with a null id or one that is
// still `isNew`. A freshly retrieved graph is clean (unmodified), so nothing is flagged;
// anything left as a `new` placeholder would be. Lites are references, not required to be
// loaded, so (as in Signum) only Entity nodes are checked.
function assertRetrieved(roots: Iterable<Entity>): void {
    const problematic = [...exploreModifiables(roots)].filter(
        a => a instanceof Entity && isModifiedSelf(a) && (a.id == null || a.isNew));
    assert.equal(problematic.length, 0,
        `Some non-retrieved elements: ${problematic.map(a => a.constructor.name).join(", ")}`);
}

describe("RetrieverTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // var list = Database.Query<CountryEntity>().ToList(); AssertRetrieved(list);
    test("RetrieveSimple", async () => {
        const list = await table(CountryEntity).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(e => e instanceof CountryEntity));
        assertRetrieved(list);
    });

    // var list = Database.Query<GrammyAwardEntity>().ToList(); AssertRetrieved(list);
    test("RetrieveWithEnum", async () => {
        const list = await table(GrammyAwardEntity).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(e => e instanceof GrammyAwardEntity));
        assertRetrieved(list);
    });

    // var list = Database.Query<LabelEntity>().ToList(); AssertRetrieved(list);
    test("RetrieveWithRelatedEntityAndLite", async () => {
        const list = await table(LabelEntity).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(e => e instanceof LabelEntity));
        assertRetrieved(list);
    });

    // var list = Database.Query<NoteWithDateEntity>().ToList(); AssertRetrieved(list);
    test("RetrieveWithIBA", async () => {
        const list = await table(NoteWithDateEntity).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(e => e instanceof NoteWithDateEntity));
        assertRetrieved(list);
    });

    // var list = Database.Query<ArtistEntity>().ToList(); AssertRetrieved(list);
    test("RetrieveWithMList", async () => {
        const list = await table(ArtistEntity).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(e => e instanceof ArtistEntity));
        assertRetrieved(list);
    });

    // var list = Database.Query<AlbumEntity>().ToList(); AssertRetrieved(list);
    test("RetrieveWithMListEmbedded", async () => {
        const list = await table(AlbumEntity).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(e => e instanceof AlbumEntity));
        assertRetrieved(list);
    });

    // var artist = Query<ArtistEntity>().OrderBy(a => a.Name).First();
    // Assert.Equal(artist.ToLite().RetrieveAndRemember().Friends.Count, artist.Friends.Count);
    test("RetrieveWithMListCount", async () => {
        const artist = await table(ArtistEntity).orderBy(a => a.name).first();
        const retrieved = await artist.toLite().retrieveAndRemember();
        assert.equal(retrieved.friends.length, artist.friends.length);
    });

    // Database.Retrieve<T>(id) — fetch a single entity by bare id.
    test("Retrieve", async () => {
        const some = await table(ArtistEntity).orderBy(a => a.name).first();
        const got = await retrieve(ArtistEntity, some.id);
        assert.equal(got.id, some.id);
        assert.ok(got instanceof ArtistEntity);
    });

    // Database.RetrieveList<T>(ids) — order preserved, duplicates repeat the same instance.
    test("RetrieveList", async () => {
        const all = await table(ArtistEntity).orderBy(a => a.name).toArray();
        const ids = all.map(a => a.id);
        const requested = [ids[ids.length - 1], ids[0], ids[0]]; // reversed + a duplicate
        const list = await retrieveList(ArtistEntity, requested);
        assert.deepEqual(list.map(a => a.id), requested);
        assert.equal(list[1], list[2]); // same instance for the duplicate id
    });

    // Database.RetrieveFromListOfLite — a MIXED list of lites (artists + bands) materialised
    // to their entities, grouped by type internally, reassembled in the original order.
    test("RetrieveFromListOfLite", async () => {
        const artists = await table(ArtistEntity).orderBy(a => a.name).toArray();
        const bands = await table(BandEntity).orderBy(a => a.name).toArray();
        const lites: any[] = [
            artists[0].toLite(),
            bands[0].toLite(),
            artists[artists.length - 1].toLite(),
            bands[0].toLite(), // duplicate, different type interleaved
        ];
        const entities = await retrieveFromListOfLite(lites);
        assert.equal(entities.length, lites.length);
        assert.ok(entities[0] instanceof ArtistEntity && entities[0].id === artists[0].id);
        assert.ok(entities[1] instanceof BandEntity && entities[1].id === bands[0].id);
        assert.ok(entities[2] instanceof ArtistEntity && entities[2].id === artists[artists.length - 1].id);
        assert.equal(entities[1], entities[3]); // same instance for the duplicate lite
    });

    // FieldEntityArray collections load eagerly on a bare retrieval (Signum's MList
    // eagerness). Validate the eager-loaded in-memory arrays match a direct SQL count of
    // the same collection, per row — proves the correlation/materialisation is correct.
    test("RetrieveEagerMList", async () => {
        const artists = await table(ArtistEntity).orderBy(a => a.name).toArray();
        const dbCounts = await table(ArtistEntity).orderBy(a => a.name).map(a => a.friends.length).toArray();
        assert.deepEqual(artists.map(a => a.friends.length), dbCounts);
    });

    // A retrieval that matches no parent rows must NOT fire the eager collection child
    // queries — Signum's lazy-child skip (`requests == null → return`). Only the main
    // SELECT runs, so `table(Artist).filter(no-match)` stays a single round-trip even
    // though Artist has an eager `friends` collection.
    test("EagerMListSkippedWhenNoRows", async () => {
        let queries = 0;
        const previous = Connector.currentLogger;
        Connector.currentLogger = { log: () => { queries++; } };
        let empty: ArtistEntity[];
        try {
            empty = await table(ArtistEntity).filter(a => a.name == "___no_such_artist___").toArray();
        } finally {
            Connector.currentLogger = previous;
        }
        assert.equal(empty.length, 0);
        assert.equal(queries, 1);
    });
});
