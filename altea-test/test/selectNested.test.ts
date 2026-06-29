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
// outer query). altea's Query<T> has no nested-subquery projection yet, so the
// natural form (an inner `table(...).toArray()` inside an outer `.map`) is
// written and the test is skipped with a TODO(api) flag. Terminals are async;
// live execution is gated on ALTEA_TEST_DB.

describe("SelectNestedTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // from l in Query<LabelEntity>() select (from a in Query<AlbumEntity>() where a.Label.Is(l) select a.ToLite()).ToList()
    // TODO(api): nested query projection — no way to project an inner Query into the outer .map
    test("SelecteNested", { skip: true }, async () => {
        const neasted = await table(LabelEntity)
            .map(l => table(AlbumEntity).filter(a => a.label.is(l)).map(a => a.toLite()).toArray())
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // from b in Query<BandEntity>() select (from a in Query<AlbumEntity>() where a.Author == b select a.ToLite()).ToList()
    // TODO(api): nested query projection — no way to project an inner Query into the outer .map
    test("SelecteNestedIB", { skip: true }, async () => {
        const neasted = await table(BandEntity)
            .map(b => table(AlbumEntity).filter(a => a.author.is(b)).map(a => a.toLite()).toArray())
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // from l in Query<LabelEntity>() join o in Query<LabelEntity>().DefaultIfEmpty() on l.Owner!.Entity equals o group l.ToLite() by o.ToLite() into g select new { Owner = g.Key, List = g.ToList(), Count = g.Count() }
    // TODO(api): defaultIfEmpty / left outer join — no .defaultIfEmpty() on Query
    test("SelecteNullableLookupColumns", { skip: true }, async () => {
        const neasted = await table(LabelEntity)
            .join(table(LabelEntity), l => l.owner, o => o.toLite(), (l, o) => ({ owner: o.toLite(), label: l.toLite() }))
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
    // TODO(api): nested query projection — no way to project an inner Query into the outer .map
    test("SelecteNestedIBPlus", { skip: true }, async () => {
        const neasted = await table(LabelEntity)
            .map(l => table(AlbumEntity)
                .filter(a => a.label.is(l))
                .map(a => ({ label: l.toLite(), author: a.author.toLite(), album: a.toLite() }))
                .toArray())
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // from a in Query<AlbumEntity>() select new { Alumum = a.ToLite(), Friends = (from b in Query<AlbumEntity>() where a.Label.Is(b.Label) select b.ToLite()).ToList() }
    // TODO(api): nested query projection — no way to project an inner Query into the outer .map
    test("SelecteNestedNonKey", { skip: true }, async () => {
        const neasted = await table(AlbumEntity)
            .map(a => ({
                alumum: a.toLite(),
                friends: table(AlbumEntity).filter(b => a.label.is(b.label)).map(b => b.toLite()).toArray(),
            }))
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // from a in Query<ArtistEntity>() select (from b in Query<BandEntity>() where b.Members.Contains(a) select b.ToLite()).ToList()
    // TODO(api): nested query projection — no way to project an inner Query into the outer .map
    test("SelecteNestedContanins", { skip: true }, async () => {
        const neasted = await table(ArtistEntity)
            .map(a => table(BandEntity)
                .filter(b => b.members.some(m => m.member.is(a)))
                .map(b => b.toLite())
                .toArray())
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // from a in Query<LabelEntity>() select (from n in Query<NoteWithDateEntity>() select n.ToLite()).ToList()
    // TODO(api): nested query projection — no way to project an inner Query into the outer .map
    test("SelecteNestedIndePendent1", { skip: true }, async () => {
        const neasted = await table(LabelEntity)
            .map(a => table(NoteWithDateEntity).map(n => n.toLite()).toArray())
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // from a in Query<LabelEntity>() select new { Label = a.ToLite(), Notes = (from n in Query<NoteWithDateEntity>() select n.ToLite()).ToList() }
    // TODO(api): nested query projection — no way to project an inner Query into the outer .map
    test("SelecteNestedIndePendent2", { skip: true }, async () => {
        const neasted = await table(LabelEntity)
            .map(a => ({
                label: a.toLite(),
                notes: table(NoteWithDateEntity).map(n => n.toLite()).toArray(),
            }))
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // from a in Query<LabelEntity>() select (from n in Query<NoteWithDateEntity>() select new { Note = n.ToLite(), Label = a.ToLite() }).ToList()
    // TODO(api): nested query projection — no way to project an inner Query into the outer .map
    test("SelecteNestedSemiIndePendent", { skip: true }, async () => {
        const neasted = await table(LabelEntity)
            .map(a => table(NoteWithDateEntity)
                .map(n => ({ note: n.toLite(), label: a.toLite() }))
                .toArray())
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // from l in Query<LabelEntity>() orderby l.Name select new { Label = l.ToLite(), Notes = (from a in Query<AlbumEntity>() where a.Label.Is(l) select a.ToLite()).ToList() }
    // TODO(api): nested query projection — no way to project an inner Query into the outer .map
    test("SelecteNestedOuterOrder", { skip: true }, async () => {
        const neasted = await table(LabelEntity)
            .orderBy(l => l.name)
            .map(l => ({
                label: l.toLite(),
                notes: table(AlbumEntity).filter(a => a.label.is(l)).map(a => a.toLite()).toArray(),
            }))
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // (from l in Query<LabelEntity>() orderby l.Name select new { Label = l.ToLite(), Notes = (from a in Query<AlbumEntity>() where a.Label.Is(l) select a.ToLite()).ToList() }).Take(10)
    // TODO(api): nested query projection — no way to project an inner Query into the outer .map
    test("SelecteNestedOuterOrderTake", { skip: true }, async () => {
        const neasted = await table(LabelEntity)
            .orderBy(l => l.name)
            .map(l => ({
                label: l.toLite(),
                notes: table(AlbumEntity).filter(a => a.label.is(l)).map(a => a.toLite()).toArray(),
            }))
            .top(10)
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // from l in Query<LabelEntity>() select new { Label = l.ToLite(), Notes = (from a in Query<AlbumEntity>() where a.Label.Is(l) orderby a.Name select a.ToLite()).ToList() }
    // TODO(api): nested query projection — no way to project an inner Query into the outer .map
    test("SelecteNestedInnerOrder", { skip: true }, async () => {
        const neasted = await table(LabelEntity)
            .map(l => ({
                label: l.toLite(),
                notes: table(AlbumEntity).filter(a => a.label.is(l)).orderBy(a => a.name).map(a => a.toLite()).toArray(),
            }))
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // from l in Query<LabelEntity>() select new { Label = l.ToLite(), Notes = (from a in Query<AlbumEntity>() where a.Label.Is(l) orderby a.Name select a.ToLite()).Take(10).ToList() }
    // TODO(api): nested query projection — no way to project an inner Query into the outer .map
    test("SelecteNestedInnerOrderTake", { skip: true }, async () => {
        const neasted = await table(LabelEntity)
            .map(l => ({
                label: l.toLite(),
                notes: table(AlbumEntity).filter(a => a.label.is(l)).orderBy(a => a.name).map(a => a.toLite()).top(10).toArray(),
            }))
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // from l in Query<LabelEntity>() select (from a in Query<AlbumEntity>() where a.Label.Is(l) select (from s in a.Songs select "{0} - {1} - {2}".FormatWith(l.Name, a.Name, s.Name)).ToList()).ToList()
    // TODO(api): nested query projection — no way to project an inner Query into the outer .map
    // TODO(api): string interpolation — no FormatWith / string formatting in query
    test("SelecteDoubleNested", { skip: true }, async () => {
        const neasted = await table(LabelEntity)
            .map(l => table(AlbumEntity)
                .filter(a => a.label.is(l))
                .map(a => a.songs.map(s => l.name + " - " + a.name + " - " + s.name))
                .toArray())
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // from l in Query<LabelEntity>() orderby l.Name select (from a in Query<AlbumEntity>() where a.Label.Is(l) orderby a.Name select a.Name).ToList()
    // TODO(api): nested query projection — no way to project an inner Query into the outer .map
    test("SelecteNestedDoubleOrder", { skip: true }, async () => {
        const neasted = await table(LabelEntity)
            .orderBy(l => l.name)
            .map(l => table(AlbumEntity).filter(a => a.label.is(l)).orderBy(a => a.name).map(a => a.name).toArray())
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // from l in Query<LabelEntity>() orderby l.Name select (from a in Query<AlbumEntity>() where a.Label.Is(l) orderby a.Name select (from s in a.Songs select "{0} - {1} - {2}".FormatWith(l.Name, a.Name, s.Name)).ToList()).ToList()
    // TODO(api): nested query projection — no way to project an inner Query into the outer .map
    // TODO(api): string interpolation — no FormatWith / string formatting in query
    test("SelecteDoubleNestedDoubleOrder", { skip: true }, async () => {
        const neasted = await table(LabelEntity)
            .orderBy(l => l.name)
            .map(l => table(AlbumEntity)
                .filter(a => a.label.is(l))
                .orderBy(a => a.name)
                .map(a => a.songs.map(s => l.name + " - " + a.name + " - " + s.name))
                .toArray())
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // from b in Query<BandEntity>() where b.Members.Select(a => a.Id).Contains(1) select b.ToLite()
    // TODO(api): collection element id projection + contains in subquery filter
    test("SelectContainsInt", { skip: true }, async () => {
        const result = await table(BandEntity)
            .filter(b => b.members.some(m => m.member.id == 1))
            .map(b => b.toLite())
            .toArray();
        assert.ok(Array.isArray(result));
    });

    // from b in Query<BandEntity>() where b.Members.Select(a => a.Sex).Contains(Sex.Female) select b.ToLite()
    // TODO(api): collection element enum projection + contains in subquery filter
    test("SelectContainsEnum", { skip: true }, async () => {
        const result = await table(BandEntity)
            .filter(b => b.members.some(m => m.member.entity.sex == Sex.Female))
            .map(b => b.toLite())
            .toArray();
        assert.ok(Array.isArray(result));
    });
});
