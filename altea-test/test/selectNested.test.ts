import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { hasDb, start } from "./setup";
import {
    LabelEntity, AlbumEntity, BandEntity, ArtistEntity, NoteWithDateEntity, Sex,
} from "../entities/music";

// Port of Signum.Test/LinqProvider/SelectNestedTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)        .Where(...) → .filter(...)
//   .Select(...)         → .map(...)       .ToList()/.ToArray() → await .toArray()
//   .OrderBy(...)        → .orderBy(...)    .Take(n)    → .top(n)
//   a.ToLite()           → a.toLite()      a.Label.Is(l) → a.label.is(l)
//   a.Author == b        → a.author.is(b)  group k → .groupBy(k) → { key, elements }
// These tests build NESTED queries (a query projected inside the select of an
// outer query). The inner query is materialised with `.toArray().$v`: `.toArray()`
// keeps it a ProjectionExpression for ChildProjectionFlattener to extract as an
// eager child query, and `.$v` is the Promise<T[]>→T[] compile-time cast so the
// projected element types as a plain nested list. Terminals are async; live
// execution is gated on ALTEA_TEST_DB.

describe("SelectNestedTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // from l in Query<LabelEntity>() select (from a in Query<AlbumEntity>() where a.Label.Is(l) select a.ToLite()).ToList()
    test("SelecteNested", async () => {
        const neasted = await table(LabelEntity)
            .map(l => table(AlbumEntity).filter(a => a.label.is(l)).map(a => a.toLite()).toArray().$v)
            .toArray();
        assert.ok(neasted.every(inner => Array.isArray(inner)));
        // Every album has a label, so the per-label buckets partition all albums.
        const total = await table(AlbumEntity).count();
        assert.equal(neasted.flat().length, total);
    });

    // from b in Query<BandEntity>() select (from a in Query<AlbumEntity>() where a.Author == b select a.ToLite()).ToList()
    test("SelecteNestedIB", async () => {
        const neasted = await table(BandEntity)
            .map(b => table(AlbumEntity).filter(a => a.author.is(b)).map(a => a.toLite()).toArray().$v)
            .toArray();
        assert.ok(neasted.every(inner => Array.isArray(inner)));
        // Sum of per-band albums = albums whose author is a band (ImplementedBy).
        assert.ok(neasted.some(inner => inner.length > 0));
    });

    // from l in Query<LabelEntity>() join o in Query<LabelEntity>().DefaultIfEmpty() on l.Owner!.Entity equals o group l.ToLite() by o.ToLite() into g select new { Owner = g.Key, List = g.ToList(), Count = g.Count() }
    // Divergence: altea has no group-join with DefaultIfEmpty (left-outer grouping), so this uses an
    // innerJoin + groupBy — labels whose owner has no match are dropped.
    test("SelecteNullableLookupColumns", async () => {
        const neasted = await table(LabelEntity)
            .innerJoin(table(LabelEntity), l => l.owner, o => o.toLite(), (l, o) => ({ owner: o.toLite(), label: l.toLite() }))
            .groupBy(x => x.owner, x => x.label)
            .map(g => ({ owner: g.key, list: g.elements, count: g.elements.length }))
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // from l in Query<LabelEntity>() group l.ToLite() by l.Owner into g select new { Owner = g.Key, List = g.ToList(), Count = g.Count() }
    test("SelecteGroupBy", async () => {
        const neasted = await table(LabelEntity)
            .groupBy(l => l.owner, l => l.toLite())
            .map(g => ({ owner: g.key, list: g.elements, count: g.elements.length }))
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // from l in Query<LabelEntity>() select (from a in Query<AlbumEntity>() where a.Label.Is(l) select new { Label = l.ToLite(), Author = a.Author.ToLite(), Album = a.ToLite() }).ToList()
    test("SelecteNestedIBPlus", async () => {
        const neasted = await table(LabelEntity)
            .map(l => table(AlbumEntity)
                .filter(a => a.label.is(l))
                .map(a => ({ label: l.toLite(), author: a.author.toLite(), album: a.toLite() }))
                .toArray().$v)
            .toArray();
        assert.ok(neasted.every(inner => Array.isArray(inner)));
        const total = await table(AlbumEntity).count();
        assert.equal(neasted.flat().length, total);
    });

    // from a in Query<AlbumEntity>() select new { Alumum = a.ToLite(), Friends = (from b in Query<AlbumEntity>() where a.Label.Is(b.Label) select b.ToLite()).ToList() }
    test("SelecteNestedNonKey", async () => {
        const neasted = await table(AlbumEntity)
            .map(a => ({
                alumum: a.toLite(),
                friends: table(AlbumEntity).filter(b => a.label.is(b.label)).map(b => b.toLite()).toArray().$v,
            }))
            .toArray();
        assert.ok(neasted.every(x => Array.isArray(x.friends)));
        // An album is always its own label-mate, so every friends list is non-empty.
        assert.ok(neasted.every(x => x.friends.length >= 1));
    });

    // from a in Query<ArtistEntity>() select (from b in Query<BandEntity>() where b.Members.Contains(a) select b.ToLite()).ToList()
    test("SelecteNestedContanins", async () => {
        const neasted = await table(ArtistEntity)
            .map(a => table(BandEntity)
                .filter(b => b.members.some(m => m.member.is(a)))
                .map(b => b.toLite())
                .toArray().$v)
            .toArray();
        assert.ok(neasted.every(inner => Array.isArray(inner)));
    });

    // from a in Query<LabelEntity>() select (from n in Query<NoteWithDateEntity>() select n.ToLite()).ToList()
    test("SelecteNestedIndePendent1", async () => {
        const neasted = await table(LabelEntity)
            .map(a => table(NoteWithDateEntity).map(n => n.toLite()).toArray().$v)
            .toArray();
        assert.ok(neasted.every(inner => Array.isArray(inner)));
        // Uncorrelated inner: every row gets the full note list.
        const notes = await table(NoteWithDateEntity).count();
        assert.ok(neasted.every(inner => inner.length === notes));
    });

    // from a in Query<LabelEntity>() select new { Label = a.ToLite(), Notes = (from n in Query<NoteWithDateEntity>() select n.ToLite()).ToList() }
    test("SelecteNestedIndePendent2", async () => {
        const neasted = await table(LabelEntity)
            .map(a => ({
                label: a.toLite(),
                notes: table(NoteWithDateEntity).map(n => n.toLite()).toArray().$v,
            }))
            .toArray();
        const notes = await table(NoteWithDateEntity).count();
        assert.ok(neasted.every(x => Array.isArray(x.notes) && x.notes.length === notes));
    });

    // from a in Query<LabelEntity>() select (from n in Query<NoteWithDateEntity>() select new { Note = n.ToLite(), Label = a.ToLite() }).ToList()
    test("SelecteNestedSemiIndePendent", async () => {
        const neasted = await table(LabelEntity)
            .map(a => table(NoteWithDateEntity)
                .map(n => ({ note: n.toLite(), label: a.toLite() }))
                .toArray().$v)
            .toArray();
        const notes = await table(NoteWithDateEntity).count();
        assert.ok(neasted.every(inner => Array.isArray(inner) && inner.length === notes));
    });

    // from l in Query<LabelEntity>() orderby l.Name select new { Label = l.ToLite(), Notes = (from a in Query<AlbumEntity>() where a.Label.Is(l) select a.ToLite()).ToList() }
    test("SelecteNestedOuterOrder", async () => {
        const neasted = await table(LabelEntity)
            .orderBy(l => l.name)
            .map(l => ({
                label: l.toLite(),
                notes: table(AlbumEntity).filter(a => a.label.is(l)).map(a => a.toLite()).toArray().$v,
            }))
            .toArray();
        assert.ok(neasted.every(x => Array.isArray(x.notes)));
        const total = await table(AlbumEntity).count();
        assert.equal(neasted.reduce((n, x) => n + x.notes.length, 0), total);
    });

    // (from l in Query<LabelEntity>() orderby l.Name select new { Label = l.ToLite(), Notes = (from a in Query<AlbumEntity>() where a.Label.Is(l) select a.ToLite()).ToList() }).Take(10)
    test("SelecteNestedOuterOrderTake", async () => {
        const neasted = await table(LabelEntity)
            .orderBy(l => l.name)
            .map(l => ({
                label: l.toLite(),
                notes: table(AlbumEntity).filter(a => a.label.is(l)).map(a => a.toLite()).toArray().$v,
            }))
            .top(10)
            .toArray();
        assert.ok(neasted.length <= 10);
        assert.ok(neasted.every(x => Array.isArray(x.notes)));
    });

    // from l in Query<LabelEntity>() select new { Label = l.ToLite(), Notes = (from a in Query<AlbumEntity>() where a.Label.Is(l) orderby a.Name select a.ToLite()).ToList() }
    test("SelecteNestedInnerOrder", async () => {
        const neasted = await table(LabelEntity)
            .map(l => ({
                label: l.toLite(),
                notes: table(AlbumEntity).filter(a => a.label.is(l)).orderBy(a => a.name).map(a => a.toLite()).toArray().$v,
            }))
            .toArray();
        assert.ok(neasted.every(x => Array.isArray(x.notes)));
        const total = await table(AlbumEntity).count();
        assert.equal(neasted.reduce((n, x) => n + x.notes.length, 0), total);
    });

    // from l in Query<LabelEntity>() select new { Label = l.ToLite(), Notes = (from a in Query<AlbumEntity>() where a.Label.Is(l) orderby a.Name select a.ToLite()).Take(10).ToList() }
    test("SelecteNestedInnerOrderTake", async () => {
        const neasted = await table(LabelEntity)
            .map(l => ({
                label: l.toLite(),
                notes: table(AlbumEntity).filter(a => a.label.is(l)).orderBy(a => a.name).map(a => a.toLite()).top(10).toArray().$v,
            }))
            .toArray();
        assert.ok(neasted.every(x => Array.isArray(x.notes) && x.notes.length <= 10));
    });

    // from l in Query<LabelEntity>() select (from a in Query<AlbumEntity>() where a.Label.Is(l) select (from s in a.Songs select "{0} - {1} - {2}".FormatWith(l.Name, a.Name, s.Name)).ToList()).ToList()
    // Divergence: no FormatWith in query — string interpolation is written as SQL concat.
    test("SelecteDoubleNested", async () => {
        const neasted = await table(LabelEntity)
            .map(l => table(AlbumEntity)
                .filter(a => a.label.is(l))
                .map(a => a.songs.map(s => l.name + " - " + a.name + " - " + s.name))
                .toArray().$v)
            .toArray();
        // label → albums → songs: three levels of nesting, innermost is a string.
        assert.ok(neasted.every(byLabel =>
            Array.isArray(byLabel) && byLabel.every(byAlbum =>
                Array.isArray(byAlbum) && byAlbum.every(s => typeof s === "string" && s.includes(" - ")))));
    });

    // from l in Query<LabelEntity>() orderby l.Name select (from a in Query<AlbumEntity>() where a.Label.Is(l) orderby a.Name select a.Name).ToList()
    test("SelecteNestedDoubleOrder", async () => {
        const neasted = await table(LabelEntity)
            .orderBy(l => l.name)
            .map(l => table(AlbumEntity).filter(a => a.label.is(l)).orderBy(a => a.name).map(a => a.name).toArray().$v)
            .toArray();
        assert.ok(neasted.every(inner => Array.isArray(inner) && inner.every(n => typeof n === "string")));
        // Each inner list is ordered by album name.
        assert.ok(neasted.every(inner => inner.every((n, i) => i === 0 || inner[i - 1] <= n)));
    });

    // from l in Query<LabelEntity>() orderby l.Name select (from a in Query<AlbumEntity>() where a.Label.Is(l) orderby a.Name select (from s in a.Songs select "{0} - {1} - {2}".FormatWith(l.Name, a.Name, s.Name)).ToList()).ToList()
    // Divergence: no FormatWith in query — string interpolation is written as SQL concat.
    test("SelecteDoubleNestedDoubleOrder", async () => {
        const neasted = await table(LabelEntity)
            .orderBy(l => l.name)
            .map(l => table(AlbumEntity)
                .filter(a => a.label.is(l))
                .orderBy(a => a.name)
                .map(a => a.songs.map(s => l.name + " - " + a.name + " - " + s.name))
                .toArray().$v)
            .toArray();
        assert.ok(neasted.every(byLabel =>
            Array.isArray(byLabel) && byLabel.every(byAlbum =>
                Array.isArray(byAlbum) && byAlbum.every(s => typeof s === "string" && s.includes(" - ")))));
    });

    // from b in Query<BandEntity>() where b.Members.Select(a => a.Id).Contains(1) select b.ToLite()
    // altea idiom: C#'s `Members.Select(a => a.Id).Contains(1)` is `members.some(m => m.member.id == 1)`.
    test("SelectContainsInt", async () => {
        const result = await table(BandEntity)
            .filter(b => b.members.some(m => m.member.id == 1))
            .map(b => b.toLite())
            .toArray();
        assert.ok(Array.isArray(result));
    });

    // from b in Query<BandEntity>() where b.Members.Select(a => a.Sex).Contains(Sex.Female) select b.ToLite()
    // altea idiom: C#'s `Members.Select(a => a.Sex).Contains(Sex.Female)` is `members.some(m => m.member.sex == Sex.Female)`.
    test("SelectContainsEnum", async () => {
        const result = await table(BandEntity)
            .filter(b => b.members.some(m => m.member.sex == Sex.Female))
            .map(b => b.toLite())
            .toArray();
        assert.ok(result.length > 0);
    });
});
