import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { Connector } from "@altea/altea/logic/connection/connector";
import { hasDb, start } from "./setup";
import {
    CountryEntity, GrammyAwardEntity, LabelEntity,
    NoteWithDateEntity, ArtistEntity, AlbumEntity,
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
// Signum's AssertRetrieved<T> walks the object graph (GraphExplorer.FromRoots)
// and fails if any reachable Entity is still IsNew / has a null id — i.e. it
// proves every row (and its related entities/lites/MLists) was actually
// retrieved, not left as a stub. altea has no GraphExplorer equivalent yet, so
// the closest live check is that the query materializes an array; the deep
// graph-completeness assertion is flagged.

describe("RetrieverTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // var list = Database.Query<CountryEntity>().ToList(); AssertRetrieved(list);
    // TODO(api): GraphExplorer.FromRoots deep retrieval-completeness assertion (AssertRetrieved)
    test("RetrieveSimple", async () => {
        const list = await table(CountryEntity).toArray();
        assert.ok(Array.isArray(list));
    });

    // var list = Database.Query<GrammyAwardEntity>().ToList(); AssertRetrieved(list);
    // TODO(api): GraphExplorer.FromRoots deep retrieval-completeness assertion (AssertRetrieved)
    test("RetrieveWithEnum", async () => {
        const list = await table(GrammyAwardEntity).toArray();
        assert.ok(Array.isArray(list));
    });

    // var list = Database.Query<LabelEntity>().ToList(); AssertRetrieved(list);
    // TODO(api): GraphExplorer.FromRoots deep retrieval-completeness assertion (AssertRetrieved)
    test("RetrieveWithRelatedEntityAndLite", async () => {
        const list = await table(LabelEntity).toArray();
        assert.ok(Array.isArray(list));
    });

    // var list = Database.Query<NoteWithDateEntity>().ToList(); AssertRetrieved(list);
    // TODO(api): GraphExplorer.FromRoots deep retrieval-completeness assertion (AssertRetrieved)
    test("RetrieveWithIBA", async () => {
        const list = await table(NoteWithDateEntity).toArray();
        assert.ok(Array.isArray(list));
    });

    // var list = Database.Query<ArtistEntity>().ToList(); AssertRetrieved(list);
    // TODO(api): GraphExplorer.FromRoots deep retrieval-completeness assertion (AssertRetrieved)
    test("RetrieveWithMList", async () => {
        const list = await table(ArtistEntity).toArray();
        assert.ok(Array.isArray(list));
    });

    // var list = Database.Query<AlbumEntity>().ToList(); AssertRetrieved(list);
    // TODO(api): GraphExplorer.FromRoots deep retrieval-completeness assertion (AssertRetrieved)
    test("RetrieveWithMListEmbedded", async () => {
        const list = await table(AlbumEntity).toArray();
        assert.ok(Array.isArray(list));
    });

    // var artist = Query<ArtistEntity>().OrderBy(a => a.Name).First();
    // Assert.Equal(artist.ToLite().RetrieveAndRemember().Friends.Count, artist.Friends.Count);
    // TODO(api): Lite.RetrieveAndRemember() (retrieve an entity from a lite) and comparing its MList count
    test("RetrieveWithMListCount", async () => {
        const artist = await table(ArtistEntity).orderBy(a => a.name).first();
        assert.equal(artist.toLite().retrieveAndRemember().friends.length, artist.friends.length);
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
