import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Serializer, registerCustomLite } from "@altea/altea/entities/serializer";
const { stringify: serialize, parse: deserialize } = Serializer;   // local aliases for the tests
import { Lite, LiteImp } from "@altea/altea/entities/lite";
import type { PrimaryKey } from "@altea/altea/entities/entity";
import { cleanModified, isModifiedSelf } from "@altea/altea/entities/changes";
import { Temporal, toInt } from "@altea/altea/entities/basics";
import {
    CountryEntity, ArtistEntity, AlbumEntity, AlbumEntity_Songs, SongEmbedded,
    NoteWithDateEntity, Sex, Status, AlbumState,
} from "../entities/music";
import { GadgetEntity } from "../entities/gadget";   // @column(false) / @serialize(false) fixture

// Unit tests for the JSON codec (Phase E). No database — the codec is pure and
// reflection-driven, so it round-trips hand-built entity graphs on either end.
// The core assertion is idempotency: serialize → deserialize → serialize is stable,
// which exercises structure, discriminators, coercion and the modified/snapshot flags
// all at once. Targeted asserts pin the specific behaviours on top of that.

function parse(json: string): any {
    return JSON.parse(json);
}

// A freshly built, id-stamped existing artist with a clean baseline snapshot.
function makeArtist(id: number, name: string): ArtistEntity {
    const a = ArtistEntity.create({ name, dead: false, sex: Sex.Male, status: null, lastAward: null, friends: [] });
    a.id = id; a.isNew = false; a.ticks = 1;
    cleanModified(a);
    return a;
}

describe("EntityJson", () => {

    test("scalars, enums, idempotency (Auto)", () => {
        const a = ArtistEntity.create({ name: "Michael", dead: true, sex: Sex.Female, status: Status.Married, lastAward: null, friends: [] });
        a.id = 1; a.isNew = false; a.ticks = 5;
        cleanModified(a);

        const json = serialize(a);
        const o = parse(json);
        assert.equal(o.$type, "Artist");
        assert.equal(o.id, 1);
        assert.equal(o.ticks, 5);
        assert.equal(o.sex, "Female");          // enum → member name
        assert.equal(o.status, "Married");
        assert.equal(o.dead, true);
        assert.equal(o.modified, undefined);    // clean ⇒ no flag

        const b = deserialize(json) as ArtistEntity;
        assert.ok(b instanceof ArtistEntity);
        assert.equal(b.name, "Michael");
        assert.equal(b.sex, Sex.Female);
        assert.equal(b.status, Status.Married);
        assert.equal(b.dead, true);
        assert.equal(b.id, 1);
        assert.equal(b.ticks, 5);
        assert.equal(isModifiedSelf(b), false); // no `modified` ⇒ clean sentinel

        assert.equal(serialize(b), json);       // idempotent
    });

    test("Temporal, @implementedByAll reference, mixin fields", () => {
        const usa = CountryEntity.create({ name: "USA" });
        usa.id = 10; usa.isNew = false; usa.ticks = 0; cleanModified(usa);

        const note = NoteWithDateEntity.create({
            title: "hello", text: "body",
            target: usa,                          // @implementedByAll (full, polymorphic)
            otherTarget: null,
            creationTime: Temporal.PlainDateTime.from("2020-01-02T03:04:05"),
            creationDate: Temporal.PlainDate.from("2020-01-02"),
            releaseDate: null,
        });
        (note as any).colaborators = [];          // ColaboratorsMixin field (not on the entity's own type)
        note.id = "11111111-1111-1111-1111-111111111111"; note.isNew = false; note.ticks = 0;
        cleanModified(note);

        const json = serialize(note);
        const o = parse(json);
        assert.equal(o.creationTime, "2020-01-02T03:04:05");         // Temporal → ISO string
        assert.equal(o.creationDate, "2020-01-02");
        assert.equal(o.target.$type, "Country");              // poly ⇒ discriminator present in Auto
        assert.equal(o.target.id, 10);
        assert.equal(o.corrupt, false);                            // CorruptMixin field, flat
        assert.deepEqual(o.colaborators, []);                      // ColaboratorsMixin field, flat

        const n2 = deserialize(json) as NoteWithDateEntity;
        assert.ok(n2 instanceof NoteWithDateEntity);
        assert.ok(n2.creationTime instanceof Temporal.PlainDateTime);
        assert.equal(n2.creationTime.toString(), "2020-01-02T03:04:05");
        assert.ok(n2.target instanceof CountryEntity);
        assert.equal(n2.target.id, 10);
        assert.equal((n2 as any).corrupt, false);
        assert.equal(serialize(n2), json);
    });

    test("thin lite and fat lite", () => {
        const a = makeArtist(2, "Alanis");

        const thin = serialize(a.toLite());
        const to = parse(thin);
        assert.equal(to.$lite, "Artist");
        assert.equal(to.id, 2);
        assert.equal(to.toStr, "Alanis");
        assert.equal(to.entity, undefined);

        const thinLite = deserialize(thin) as Lite<ArtistEntity>;
        assert.ok(thinLite instanceof Lite);
        assert.equal(thinLite.id, 2);
        assert.equal(thinLite.toString(), "Alanis");
        assert.equal(thinLite.entityOrNull, undefined);

        const fat = serialize(a.toLite(true));
        const fo = parse(fat);
        assert.equal(fo.$lite, "Artist");
        assert.ok(fo.entity != null && fo.entity.name === "Alanis");

        const fatLite = deserialize(fat) as Lite<ArtistEntity>;
        assert.ok(fatLite.entityOrNull instanceof ArtistEntity);
        assert.equal(fatLite.entity.name, "Alanis");
    });

    test("custom lite: isCompatible selection with LiteImp fallback", () => {
        class CountryLite extends LiteImp<CountryEntity> {
            constructor(id: PrimaryKey, toStr: string, readonly iso: string) {
                super(id, CountryEntity, toStr);
            }
            static isCompatible(json: Record<string, unknown>): boolean {
                return typeof json.iso === "string";
            }
            static fromJson(json: Record<string, unknown>): Lite<CountryEntity> {
                return new CountryLite(json.id as PrimaryKey, (json.toStr as string) ?? "", json.iso as string);
            }
        }
        registerCustomLite(CountryEntity, CountryLite);

        const custom = new CountryLite(10, "USA", "US");
        const json = serialize(custom);
        const o = parse(json);
        assert.equal(o.$lite, "Country");
        assert.equal(o.iso, "US");                                  // custom field, flat on the lite

        const back = deserialize(json) as CountryLite;
        assert.ok(back instanceof CountryLite);
        assert.equal(back.iso, "US");
        assert.equal(serialize(back), json);

        // A country lite without the custom field falls back to LiteImp.
        const usa = CountryEntity.create({ name: "USA" }); usa.id = 10; usa.isNew = false; cleanModified(usa);
        const plain = deserialize(serialize(usa.toLite()));
        assert.ok(plain instanceof LiteImp);
        assert.ok(!(plain instanceof CountryLite));
    });

    test("embedded + part-entity collection: back-ref/order skipped and recovered", () => {
        const artist = makeArtist(2, "A");
        const album = AlbumEntity.create({
            name: "Alb", year: toInt(2000), author: artist,
            songs: [], bonusTrack: SongEmbedded.create({ name: "bt", duration: null, seconds: toInt(200), index: toInt(0) }),
            state: AlbumState.Saved,
        });
        album.id = 3; album.isNew = false; album.ticks = 0;
        const s1 = AlbumEntity_Songs.create({ name: "s1", duration: null, seconds: toInt(100), index: toInt(0) });
        const s2 = AlbumEntity_Songs.create({ name: "s2", duration: Temporal.Duration.from("PT3M"), seconds: toInt(180), index: toInt(0) });
        album.songs = [s1, s2];

        const json = serialize(album);
        const o = parse(json);
        assert.equal(o.author.$type, "Artist");              // @implementedBy ⇒ discriminator
        assert.equal(o.songs[0].$type, undefined);                 // Auto, monomorphic ⇒ inferred
        assert.equal(o.songs[0].album, undefined);                 // @backReference skipped
        assert.equal(o.songs[0].order, undefined);                 // @rowOrder skipped
        assert.equal(o.bonusTrack.name, "bt");

        const a2 = deserialize(json) as AlbumEntity;
        assert.equal(a2.songs.length, 2);
        assert.ok(a2.bonusTrack instanceof SongEmbedded);
        // back-reference recovered as a fat lite pointing at the owner; order from index.
        assert.ok(a2.songs[0].album instanceof Lite);
        assert.equal(a2.songs[0].album.entityOrNull, a2);
        assert.equal(a2.songs[0].order, 0);
        assert.equal(a2.songs[1].order, 1);
        assert.equal(a2.songs[1].duration?.toString(), "PT3M");

        assert.equal(serialize(a2), json);                         // idempotent
    });

    test("writeTypes Always vs Auto", () => {
        const artist = makeArtist(2, "A");
        const album = AlbumEntity.create({
            name: "Alb", year: toInt(2000), author: artist, songs: [],
            bonusTrack: SongEmbedded.create({ name: "bt", duration: null, seconds: toInt(1), index: toInt(0) }),
            state: AlbumState.New,
        });
        album.id = 3; album.isNew = false;
        album.songs = [AlbumEntity_Songs.create({ name: "s1", duration: null, seconds: toInt(1), index: toInt(0) })];

        const auto = parse(serialize(album, { writeTypes: "Auto" }));
        assert.equal(auto.songs[0].$type, undefined);              // inferred
        assert.equal(auto.bonusTrack.$type, undefined);

        const always = parse(serialize(album, { writeTypes: "Always" }));
        assert.equal(always.$type, "Album");
        assert.equal(always.songs[0].$type, "AlbumEntity_Songs");  // explicit
        assert.equal(always.bonusTrack.$type, "SongEmbedded");
        assert.equal(always.songs[0].album, undefined);            // back-ref still skipped (both modes)

        // Both modes still round-trip.
        assert.ok(deserialize(serialize(album, { writeTypes: "Always" })) instanceof AlbumEntity);
        assert.ok(deserialize(serialize(album, { writeTypes: "Auto" })) instanceof AlbumEntity);
    });

    test("modified flag both directions", () => {
        const a = makeArtist(4, "Clean");
        assert.equal(parse(serialize(a)).modified, undefined);     // clean

        a.name = "Dirty";                                          // now self-modified vs its snapshot
        assert.equal(isModifiedSelf(a), true);
        assert.equal(parse(serialize(a)).modified, true);

        const revived = deserialize(serialize(a)) as ArtistEntity;
        assert.equal(isModifiedSelf(revived), true);               // modified:true ⇒ true sentinel

        // new entity (no id) is always modified
        const fresh = ArtistEntity.create({ name: "New", dead: false, sex: Sex.Male, status: null, lastAward: null, friends: [] });
        assert.equal(parse(serialize(fresh)).modified, true);
        assert.equal(parse(serialize(fresh)).id, null);
        const freshBack = deserialize(serialize(fresh)) as ArtistEntity;
        assert.ok(freshBack.id == null);          // new ⇒ no id (undefined)
        assert.equal(freshBack.isNew, true);
        assert.equal(isModifiedSelf(freshBack), true);
    });

    test("resolve guard: overlay when modified, skip + warn when not", () => {
        // modified ⇒ overlay onto the resolved original (identity preserved)
        const original = makeArtist(7, "Orig");
        const incoming = ArtistEntity.create({ name: "New", dead: false, sex: Sex.Male, status: null, lastAward: null, friends: [] });
        incoming.id = 7; incoming.isNew = false; incoming.ticks = 1;   // no cleanModified ⇒ modified:true
        const resolve = (t: string, id: PrimaryKey) => (t === "Artist" && id === 7 ? original : undefined);

        const applied = deserialize(serialize(incoming), { resolve }) as ArtistEntity;
        assert.equal(applied, original);                           // same instance reused
        assert.equal(applied.name, "New");                         // overlaid
        assert.equal(isModifiedSelf(applied), true);

        // not modified but values differ ⇒ NOT applied + warn
        const original2 = makeArtist(7, "Orig");
        const clean = makeArtist(7, "Changed");                    // clean ⇒ no modified flag
        let warned = false;
        const applied2 = deserialize(serialize(clean), { resolve: () => original2, onWarn: () => { warned = true; } }) as ArtistEntity;
        assert.equal(applied2, original2);
        assert.equal(applied2.name, "Orig");                       // unchanged
        assert.equal(warned, true);

        // not modified and values match ⇒ no warn
        const original3 = makeArtist(7, "Same");
        const match = makeArtist(7, "Same");
        let warned3 = false;
        deserialize(serialize(match), { resolve: () => original3, onWarn: () => { warned3 = true; } });
        assert.equal(warned3, false);
    });

    test("@column(false) fields serialize; @serialize(false) fields do not", () => {
        const g = GadgetEntity.create({ name: "G", cachedLabel: "cached", secret: "hunter2" });
        g.id = 1; g.isNew = false; cleanModified(g);

        const o = parse(serialize(g));
        assert.equal(o.name, "G");
        assert.equal(o.cachedLabel, "cached");        // @column(false) ⇒ still serialized
        assert.equal("secret" in o, false);           // @serialize(false) ⇒ omitted
        assert.equal("isNew" in o, false);            // framework bookkeeping (@serialize(false))
        assert.equal("_snapshot" in o, false);

        const back = deserialize(serialize(g)) as GadgetEntity;
        assert.equal(back.cachedLabel, "cached");     // @column(false) field round-trips
        assert.equal(back.secret, "");                // @serialize(false) field left at its default
        assert.equal(serialize(back), serialize(g));  // idempotent
    });

    test("dynamic top-level: array, dictionary, identity reuse", () => {
        const c1 = CountryEntity.create({ name: "A" }); c1.id = 10; c1.isNew = false; cleanModified(c1);
        const c2 = CountryEntity.create({ name: "B" }); c2.id = 11; c2.isNew = false; cleanModified(c2);

        const arr = deserialize(serialize([c1, c2])) as CountryEntity[];
        assert.ok(Array.isArray(arr) && arr.length === 2);
        assert.ok(arr[0] instanceof CountryEntity && arr[0].name === "A");
        assert.equal(arr[1].id, 11);

        const dict = deserialize(serialize({ x: c1, y: c1.toLite() })) as { x: CountryEntity; y: Lite<CountryEntity> };
        assert.ok(dict.x instanceof CountryEntity);
        assert.ok(dict.y instanceof Lite);
        assert.equal(dict.y.id, 10);

        // the same entity referenced twice deserializes to one shared instance
        const shared = deserialize(serialize({ a: c1, b: c1 })) as { a: CountryEntity; b: CountryEntity };
        assert.equal(shared.a, shared.b);
    });
});
