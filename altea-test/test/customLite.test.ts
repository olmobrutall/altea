import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { hasDb, start } from "./setup";
import { Serializer } from "@altea/altea/entities/serializer";
const { stringify: serialize, parse: deserialize } = Serializer;
import { Lite, LiteImp } from "@altea/altea/entities/lite";
import { cleanModified } from "@altea/altea/entities/changes";
import { getTypeInfo } from "@altea/altea/entities/reflection";
import { toInt } from "@altea/altea/entities/basics";
import {
    ArtistEntity, BandEntity, GrammyAwardEntity, AwardNominationEntity,
    ArtistLite, BandLite, Sex, AwardResult,
} from "../entities/music";

// Custom-lite feature (Signum's LiteModel): in memory, JSON, AND live queries. altea has no
// separate LiteModel entity: a custom lite is a LiteImp subclass carrying model fields (see
// music.ts ArtistLite / BandLite). ArtistLite is registered as the DEFAULT for ArtistEntity;
// BandLite is registered NON-default for BandEntity and wired onto AwardNominationEntity.author
// via @customLite. The fromEntity builder is a Quoted lambda, so the query provider translates it
// and projects the typed lite (the "in queries" suite, DB-gated); the in-memory + JSON suites need
// no DB.

function makeArtist(id: number, name: string, sex: Sex): ArtistEntity {
    const a = ArtistEntity.create({ name, dead: false, sex, status: null, lastAward: null, friends: [] });
    a.id = id; a.isNew = false; a.ticks = 0; cleanModified(a);
    return a;
}

function makeBand(id: number, name: string): BandEntity {
    const b = BandEntity.create({ name, members: [], lastAward: null, otherAwards: [] });
    b.id = id; b.isNew = false; b.ticks = 0; cleanModified(b);
    return b;
}

function makeGrammy(id: number): GrammyAwardEntity {
    const g = GrammyAwardEntity.create({ year: toInt(2000), category: "Rock", result: AwardResult.Won });
    g.id = id; g.isNew = false; g.ticks = 0; cleanModified(g);
    return g;
}

describe("CustomLite (in memory)", () => {

    // A registered DEFAULT custom lite is what toLite() builds.
    test("toLite() uses the registered default custom lite", () => {
        const artist = makeArtist(1, "Michael", Sex.Male);
        const lite = artist.toLite();
        assert.ok(lite instanceof ArtistLite);
        assert.equal((lite as ArtistLite).sex, Sex.Male);
        assert.equal(lite.toString(), "Michael");
    });

    // A NON-default custom lite does not hijack toLite() — it falls back to a plain LiteImp.
    test("toLite() falls back to LiteImp when the type's only custom lite is non-default", () => {
        const band = makeBand(2, "Queen");
        const lite = band.toLite();
        assert.ok(lite instanceof LiteImp);
        assert.ok(!(lite instanceof BandLite));
    });

    // toCustomLite(Class) builds a SPECIFIC registered custom lite, default or not.
    test("toCustomLite() builds the named custom lite", () => {
        const band = makeBand(2, "Queen");
        const lite = band.toCustomLite(BandLite);
        assert.ok(lite instanceof BandLite);
        assert.equal((lite as BandLite).memberCount, 0);

        // fat variant embeds the entity, like toLite(true).
        const fat = band.toCustomLite(BandLite, true);
        assert.equal(fat.entityOrNull, band);
    });

    // Asking for a custom lite class that was never registered for the type is an error.
    test("toCustomLite() throws for an unregistered class", () => {
        const artist = makeArtist(1, "Michael", Sex.Male);
        assert.throws(() => artist.toCustomLite(BandLite), /No custom lite 'BandLite' is registered for 'Artist/);
    });
});

describe("CustomLite (JSON)", () => {

    // A default custom lite round-trips through the codec.
    test("ArtistLite round-trips", () => {
        const lite = makeArtist(1, "Michael", Sex.Female).toLite();
        const o = JSON.parse(serialize(lite));
        assert.equal(o.$lite, "Artist");
        assert.equal(o.sex, Sex.Female);

        const back = deserialize(serialize(lite)) as ArtistLite;
        assert.ok(back instanceof ArtistLite);
        assert.equal(back.sex, Sex.Female);
        assert.equal(serialize(back), serialize(lite));
    });

    // The @customLite override on AwardNominationEntity.author: a band author deserializes as
    // BandLite; an artist author uses its default (ArtistLite).
    test("@customLite overrides the field's lite per implementation type", () => {
        const nom = AwardNominationEntity.create({
            author: makeBand(20, "Queen").toCustomLite(BandLite),
            award: makeGrammy(30).toLite(),
            year: toInt(1990), order: toInt(0), points: [],
        });
        nom.id = 40; nom.isNew = false; nom.ticks = 0; cleanModified(nom);

        const back = deserialize(serialize(nom)) as AwardNominationEntity;
        assert.ok(back.author instanceof BandLite);
        assert.equal((back.author as unknown as BandLite).memberCount, 0);

        const nom2 = AwardNominationEntity.create({
            author: makeArtist(21, "Alanis", Sex.Female).toLite(),   // default ArtistLite
            award: makeGrammy(31).toLite(),
            year: toInt(1995), order: toInt(0), points: [],
        });
        nom2.id = 41; nom2.isNew = false; nom2.ticks = 0; cleanModified(nom2);

        const back2 = deserialize(serialize(nom2)) as AwardNominationEntity;
        assert.ok(back2.author instanceof ArtistLite);
    });

    // The override is load-bearing: even a PLAIN band lite (no model on the wire) becomes a
    // BandLite on this field, whereas the same wire with no field context stays a LiteImp.
    test("@customLite forces the class even for a plain lite; top-level has no override", () => {
        const band = makeBand(20, "Queen");
        const nom = AwardNominationEntity.create({
            author: band.toLite(),                 // plain LiteImp (Band's default is LiteImp)
            award: makeGrammy(30).toLite(),
            year: toInt(1990), order: toInt(0), points: [],
        });
        nom.id = 42; nom.isNew = false; nom.ticks = 0; cleanModified(nom);

        const wire = JSON.parse(serialize(nom));
        assert.equal(wire.author.$lite, "Band");
        assert.equal(wire.author.memberCount, undefined);   // plain lite, no model on the wire

        const back = deserialize(serialize(nom)) as AwardNominationEntity;
        assert.ok(back.author instanceof BandLite);          // field @customLite forced it

        // The identical wire, deserialized with no field context, falls back to LiteImp.
        const topLevel = deserialize(serialize(band.toLite()));
        assert.ok(topLevel instanceof LiteImp && !(topLevel instanceof BandLite));
    });

    // The decorator is recorded on the field's reflection metadata (a list — a field may carry
    // several @customLite, one per implementation type).
    test("@customLite is recorded on the field", () => {
        const fi = getTypeInfo(AwardNominationEntity)!.fields.author;
        assert.ok(Array.isArray(fi.customLite) && fi.customLite.length === 1);
        assert.equal((fi.customLite![0].liteClass() as { name: string }).name, "BandLite");
        assert.equal((fi.customLite![0].forEntityType() as { name: string }).name, "BandEntity");
    });
});

// Query-side custom-lite materialisation (Signum's SelectLiteModel). The provider translates the
// registered `fromEntity` Quoted lambda into projected columns and builds the typed lite in the
// reader. Gated on ALTEA_TEST_DB.
describe("CustomLite (in queries)", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Projecting a.toLite() over a type with a DEFAULT custom lite yields that lite, with its
    // model field populated from the projected column.
    test("toLite() projects the default custom lite", async () => {
        const lites = await table(ArtistEntity).map(a => a.toLite()).toArray();
        assert.ok(lites.length > 0);
        assert.ok(lites.every(l => l instanceof ArtistLite));
        assert.ok(lites.every(l => (l as ArtistLite).sex === Sex.Male || (l as ArtistLite).sex === Sex.Female || (l as ArtistLite).sex === Sex.Undefined));
    });

    // SelectLiteModel: the polymorphic author lite comes back as ArtistLite for artists (the
    // registered default) and BandLite for bands (the field's @customLite override).
    test("@customLite drives the polymorphic author lite per type", async () => {
        const authors = await table(AwardNominationEntity).map(n => n.author).toArray();
        assert.ok(authors.length > 0);
        for (const a of authors) {
            if (a!.entityType === ArtistEntity)
                assert.ok(a instanceof ArtistLite, `expected ArtistLite, got ${a!.constructor.name}`);
            else if (a!.entityType === BandEntity)
                assert.ok(a instanceof BandLite, `expected BandLite, got ${a!.constructor.name}`);
        }
        assert.ok(authors.some(a => a instanceof ArtistLite));
        assert.ok(authors.some(a => a instanceof BandLite));
    });

    // A band lite reached through its default (plain toLite) is a LiteImp — the @customLite override
    // applies only to the decorated field, not to band lites generally.
    test("band toLite() stays a LiteImp (BandLite is non-default)", async () => {
        const bands = await table(BandEntity).map(b => b.toLite()).toArray();
        assert.ok(bands.length > 0);
        assert.ok(bands.every(l => l instanceof LiteImp && !(l instanceof BandLite)));
    });
});
