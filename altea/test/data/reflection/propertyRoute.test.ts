import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { PropertyRoute, PropertyRouteType } from "@altea/altea/data/propertyRoute";
import { Implementations } from "@altea/altea/data/implementations";
import { Entity } from "@altea/altea/data/entity";
import { reflect } from "@altea/altea/data/reflection";
import { backReference, part } from "@altea/altea/data/decorators";
import type { Lite } from "@altea/altea/data/lite";
import {
    AlbumEntity, AlbumEntity_Song, LabelEntity, CountryEntity, ArtistEntity, BandEntity,
} from "../music";

// Phase-0 DynamicQuery port: PropertyRoute + Implementations. DB-free — routes are pure
// reflection over the imported entity metadata, so no schema/connector is needed.

// A SINGLE `@part` reference — what altea writes where Signum declares an owned EmbeddedEntity. The
// music model has only part COLLECTIONS, and this belongs to no suite's schema, so it is declared here
// rather than in the fixture (nothing includes it, so no database gains a table).
@part
class RouteProbeEntity_Address extends Entity {
    @backReference
    owner: Lite<RouteProbeEntity>;
    city: string;
}

@reflect
class RouteProbeEntity extends Entity {
    shipAddress: RouteProbeEntity_Address;
    label: LabelEntity;
}

describe("PropertyRoute — roots & value fields", () => {
    test("root toString uses clean name", () => {
        assert.equal(PropertyRoute.root(AlbumEntity).toString(), "(Album)");
        assert.equal(PropertyRoute.root(LabelEntity).propertyRouteType, PropertyRouteType.Root);
    });

    test("string field", () => {
        const pr = PropertyRoute.root(LabelEntity).add("name");
        assert.equal(pr.propertyRouteType, PropertyRouteType.FieldOrProperty);
        assert.equal(pr.type.typeName, "String");
        assert.equal(pr.toString(), "(Label).name");
        assert.equal(pr.propertyString(), "name");
        assert.equal(pr.rootType, LabelEntity);
    });

    test("number field", () => {
        const pr = PropertyRoute.root(AlbumEntity).add("year");
        assert.equal(pr.type.typeName, "Number");
    });

    test("enum field yields EnumType and is not an entity reference", () => {
        const pr = PropertyRoute.root(ArtistEntity).add("sex");
        assert.ok(pr.type.getEnum() != null);
        assert.equal(pr.tryGetImplementations(), undefined);
    });
});

describe("PropertyRoute — references re-root (AddImp)", () => {
    test("plain entity reference: implementations = single concrete", () => {
        const pr = PropertyRoute.root(LabelEntity).add("country");
        assert.equal(pr.type.getFunction(), CountryEntity);
        const imp = pr.tryGetImplementations();
        assert.ok(imp);
        assert.equal(imp!.only(), CountryEntity);
        assert.equal(pr.toString(), "(Label).country");
    });

    test("navigating a reference re-roots at the referenced type", () => {
        const pr = PropertyRoute.root(LabelEntity).add("country").add("name");
        assert.equal(pr.rootType, CountryEntity);
        assert.equal(pr.toString(), "(Country).name");
        assert.equal(pr.type.typeName, "String");
    });

    test("lite reference: type is LiteType, navigation re-roots", () => {
        const owner = PropertyRoute.root(LabelEntity).add("owner"); // Lite<LabelEntity> | null
        assert.ok(owner.type.lite);
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
        assert.ok(songs.type.array);
        const item = songs.add("Item");
        assert.equal(item.propertyRouteType, PropertyRouteType.MListItems);
        assert.equal(songs.getMListItemsRoute(), undefined);
        assert.equal(item.getMListItemsRoute(), item);
        assert.equal(songs.toString(), "(Album).songs");
        assert.equal(item.toString(), "(Album).songs/");
    });

    // altea models Signum's MList<SongEmbedded> as a part-ENTITY collection (AlbumEntity_Song[]), so the
    // element LOOKS like an entity reference — but a `@part` does NOT re-root (see isPartType). The route
    // stays the owner's, which is what the `/` in the path says and what Signum's own route for the same
    // model is: `Songs/Name`, a route of Album.
    test("member off an MListItems @part element CONTINUES the owner's route", () => {
        const item = PropertyRoute.root(AlbumEntity).add("songs").add("Item");
        assert.equal(item.type.getFunction(), AlbumEntity_Song);

        const name = item.add("name");
        assert.equal(name.propertyRouteType, PropertyRouteType.FieldOrProperty);
        assert.equal(name.rootType, AlbumEntity);
        assert.equal(name.type.typeName, "String");
        assert.equal(name.toString(), "(Album).songs/name");
        assert.equal(name.propertyString(), "songs/name");
    });

    // generateRoutes descends a @part for the same reason: its members ARE routes of the owner.
    test("generateRoutes emits a @part collection element's members under the owner", () => {
        const paths = PropertyRoute.generateRoutes(AlbumEntity, true).map(r => r.propertyString());
        assert.ok(paths.includes("songs/name"), paths.join(", "));
    });
});

describe("PropertyRoute — @part references", () => {
    // A part reached through a SINGLE field behaves exactly as one reached through a collection: it is
    // what altea writes where Signum declares an owned EmbeddedEntity, whose members are routes of the
    // OWNER — `ShipAddress.City`, not `(Address).City`.
    test("a single @part reference CONTINUES the route", () => {
        const city = PropertyRoute.root(RouteProbeEntity).add("shipAddress").add("city");
        assert.equal(city.rootType, RouteProbeEntity);
        assert.equal(city.propertyString(), "shipAddress.city");
    });

    // …while an ordinary reference still re-roots, which is Signum's AddImp unchanged.
    test("a plain entity reference still re-roots", () => {
        const name = PropertyRoute.root(RouteProbeEntity).add("label").add("name");
        assert.equal(name.rootType, LabelEntity);
        assert.equal(name.propertyString(), "name");
    });

    test("generateRoutes descends a single @part", () => {
        const paths = PropertyRoute.generateRoutes(RouteProbeEntity).map(r => r.propertyString());
        assert.ok(paths.includes("shipAddress.city"), paths.join(", "));
        assert.ok(!paths.some(p => p === "label.name"), paths.join(", "));
    });

    // `includeArrayElements` is Signum's `includeMListElements` and gates only the BARE element route.
    // Signum calls `GenerateEmbeddedProperties(itemRoute, …)` OUTSIDE the flag, so `Songs/Name` is a route
    // of Album whoever is asking — which is why the property-auth pack (false, as Signum's is) sees it.
    // altea had gated the whole descent on the flag, so the pack saw no collection member at all and
    // Southwind's `Product|AdditionalInformation/Key` rule had no counterpart here.
    test("includeArrayElements gates the BARE element route, not the descent into it", () => {
        const off = PropertyRoute.generateRoutes(AlbumEntity, false).map(r => r.propertyString());
        assert.ok(off.includes("songs/name"), off.join(", "));
        assert.ok(!off.some(p => p.endsWith("/")), off.join(", "));

        const on = PropertyRoute.generateRoutes(AlbumEntity, true).map(r => r.propertyString());
        assert.ok(on.includes("songs/"), on.join(", "));
    });

    // A part stands in for a Signum embedded / MList element, which has no `Id`, no `Ticks`, and no
    // `Parent` / `Order` PROPERTY (those are MList table columns, built with a null route). Emitting them
    // would offer four routes per collection that a Signum database has no counterpart for.
    test("a row's bookkeeping is not a route of the owner", () => {
        const paths = PropertyRoute.generateRoutes(AlbumEntity, true).map(r => r.propertyString());
        for (const noise of ["songs/id", "songs/ticks", "songs/album", "songs/order"])
            assert.ok(!paths.includes(noise), `${noise} in ${paths.join(", ")}`);
        assert.ok(paths.includes("id") && paths.includes("ticks"), paths.join(", "));   // …at the root they are
    });

    // The enforcement point: a part root is a fine TRANSIENT handle (a row in a modal, a @backReference
    // walking up and out of the subtree) but must never be written down, or the same member has two names.
    test("assertNotPartRoot refuses a part-rooted route and passes an owner-rooted one", () => {
        assert.throws(() => PropertyRoute.root(AlbumEntity_Song).add("name").assertNotPartRoot(), /@part/);
        PropertyRoute.root(AlbumEntity).add("songs").add("Item").add("name").assertNotPartRoot();
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
