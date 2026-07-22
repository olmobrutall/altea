import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { PropertyRoute, PropertyRouteType } from "@altea/altea/entities/propertyRoute";
import { Implementations } from "@altea/altea/entities/implementations";
import { ClassType, LiteType, ArrayType, EnumType, LiteralType } from "@altea/altea/entities/runtimeTypes";
import {
    AlbumEntity, AlbumEntity_Songs, LabelEntity, CountryEntity, ArtistEntity, BandEntity,
} from "../../entities/music";

// Phase-0 DynamicQuery port: PropertyRoute + Implementations. DB-free — routes are pure
// reflection over the imported entity metadata, so no schema/connector is needed.

describe("PropertyRoute — roots & value fields", () => {
    test("root toString uses clean name", () => {
        assert.equal(PropertyRoute.root(AlbumEntity).toString(), "(Album)");
        assert.equal(PropertyRoute.root(LabelEntity).propertyRouteType, PropertyRouteType.Root);
    });

    test("string field", () => {
        const pr = PropertyRoute.root(LabelEntity).add("name");
        assert.equal(pr.propertyRouteType, PropertyRouteType.FieldOrProperty);
        assert.equal(pr.type, LiteralType.string);
        assert.equal(pr.toString(), "(Label).name");
        assert.equal(pr.propertyString(), "name");
        assert.equal(pr.rootType, LabelEntity);
    });

    test("number field", () => {
        const pr = PropertyRoute.root(AlbumEntity).add("year");
        assert.equal(pr.type, LiteralType.number);
    });

    test("enum field yields EnumType and is not an entity reference", () => {
        const pr = PropertyRoute.root(ArtistEntity).add("sex");
        assert.ok(pr.type instanceof EnumType);
        assert.equal(pr.tryGetImplementations(), undefined);
    });
});

describe("PropertyRoute — references re-root (AddImp)", () => {
    test("plain entity reference: implementations = single concrete", () => {
        const pr = PropertyRoute.root(LabelEntity).add("country");
        assert.ok(pr.type instanceof ClassType);
        assert.equal((pr.type as ClassType).constructorFunction, CountryEntity);
        const imp = pr.tryGetImplementations();
        assert.ok(imp);
        assert.equal(imp!.only(), CountryEntity);
        assert.equal(pr.toString(), "(Label).country");
    });

    test("navigating a reference re-roots at the referenced type", () => {
        const pr = PropertyRoute.root(LabelEntity).add("country").add("name");
        assert.equal(pr.rootType, CountryEntity);
        assert.equal(pr.toString(), "(Country).name");
        assert.equal(pr.type, LiteralType.string);
    });

    test("lite reference: type is LiteType, navigation re-roots", () => {
        const owner = PropertyRoute.root(LabelEntity).add("owner"); // Lite<LabelEntity> | null
        assert.ok(owner.type instanceof LiteType);
        assert.equal(owner.tryGetImplementations()!.only(), LabelEntity);

        const ownerName = owner.add("name");
        assert.equal(ownerName.rootType, LabelEntity);
        assert.equal(ownerName.toString(), "(Label).name");
    });
});

describe("PropertyRoute — polymorphic references", () => {
    test("@implementedBy exposes all implementations", () => {
        const pr = PropertyRoute.root(AlbumEntity).add("author");
        const imp = pr.tryGetImplementations();
        assert.ok(imp);
        assert.equal(imp!.isByAll, false);
        assert.deepEqual(new Set(imp!.types), new Set([ArtistEntity, BandEntity]));
    });

    test("navigating through a polymorphic reference throws (cast first)", () => {
        const pr = PropertyRoute.root(AlbumEntity).add("author");
        assert.throws(() => pr.add("name"), /Cast first/);
    });

    test("@implementedByAll is byAll", () => {
        const pr = PropertyRoute.root(ArtistEntity).add("lastAward");
        assert.equal(pr.tryGetImplementations()!.isByAll, true);
    });
});

describe("PropertyRoute — collections", () => {
    test("collection field is an ArrayType; Item is an MListItems route", () => {
        const songs = PropertyRoute.root(AlbumEntity).add("songs");
        assert.ok(songs.type instanceof ArrayType);
        const item = songs.add("Item");
        assert.equal(item.propertyRouteType, PropertyRouteType.MListItems);
        assert.equal(songs.getMListItemsRoute(), undefined);
        assert.equal(item.getMListItemsRoute(), item);
        assert.equal(songs.toString(), "(Album).songs");
        assert.equal(item.toString(), "(Album).songs/");
    });

    // altea models Signum's MList<SongEmbedded> as a part-ENTITY collection
    // (AlbumEntity_Songs[]). So the element is an entity reference, and navigating a
    // member off `(Album).songs/` RE-ROOTS at AlbumEntity_Songs (Signum's AddImp — same
    // as navigating any MList<Entity> element, e.g. Band.Members). The owner-collection
    // context ("(Album).songs/") is intentionally dropped: format/validators/implementations
    // for the member live on AlbumEntity_Songs, and the token's own FullKey (built from
    // token Keys, not the route) carries the navigation identity.
    test("member off an MListItems entity element re-roots at the element entity", () => {
        const item = PropertyRoute.root(AlbumEntity).add("songs").add("Item");
        assert.equal((item.type as ClassType).constructorFunction, AlbumEntity_Songs);

        const name = item.add("name");
        assert.equal(name.propertyRouteType, PropertyRouteType.FieldOrProperty);
        assert.equal(name.rootType, AlbumEntity_Songs);
        assert.equal(name.type, LiteralType.string);
        assert.equal(name.toString(), "(AlbumEntity_Songs).name");
        assert.equal(name.propertyString(), "name");
    });
});

describe("PropertyRoute — parse & equality", () => {
    test("parse round-trips through re-rooting", () => {
        const pr = PropertyRoute.parse(LabelEntity, "country.name");
        assert.equal(pr.toString(), "(Country).name");
    });

    test("parseFull resolves the clean name", () => {
        const pr = PropertyRoute.parseFull("(Label).name");
        assert.equal(pr.rootType, LabelEntity);
        assert.equal(pr.member, "name");
    });

    test("equals compares root + path", () => {
        const a = PropertyRoute.root(LabelEntity).add("name");
        const b = PropertyRoute.parse(LabelEntity, "name");
        const c = PropertyRoute.root(LabelEntity).add("country");
        assert.ok(a.equals(b));
        assert.ok(!a.equals(c));
    });
});

describe("Implementations", () => {
    test("by / only / byAll", () => {
        assert.equal(Implementations.by(CountryEntity).only(), CountryEntity);
        assert.equal(Implementations.by(ArtistEntity, BandEntity).only(), undefined);
        assert.equal(Implementations.byAll.isByAll, true);
    });

    test("equals ignores order", () => {
        assert.ok(Implementations.by(ArtistEntity, BandEntity).equals(Implementations.by(BandEntity, ArtistEntity)));
        assert.ok(!Implementations.by(ArtistEntity).equals(Implementations.byAll));
    });

    test("key uses clean names", () => {
        assert.equal(Implementations.by(ArtistEntity, BandEntity).key(), "Artist, Band");
        assert.equal(Implementations.byAll.key(), "[ALL]");
    });
});
