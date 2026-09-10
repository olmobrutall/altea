import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { PropertyRoute, PropertyRouteType, setLegacyPropertyPaths } from "@altea/altea/data/propertyRoute";
import { Implementations } from "@altea/altea/data/implementations";
import { Entity, MixinEntity } from "@altea/altea/data/entity";
import { mixin } from "@altea/altea/data/mixinDeclarations";
import { reflect } from "@altea/altea/data/reflection";
import { backReference, part } from "@altea/altea/data/decorators";
import type { Lite } from "@altea/altea/data/lite";
import {
    AlbumEntity, AlbumEntity_Song, LabelEntity, CountryEntity, ArtistEntity, BandEntity,
} from "../music";
import {
    CastProbeEntity, CastProbeTextPartEntity, CastProbeImagePartEntity,
} from "../castProbe";

// Phase-0 DynamicQuery port: PropertyRoute + Implementations. DB-free — routes are pure
// reflection over the imported entity metadata, so no schema/connector is needed.

// A SINGLE `@part` reference — what altea writes where Signum declares an owned EmbeddedEntity. The
// music model has only part COLLECTIONS, and this belongs to no suite's schema, so it is declared here
// rather than in the fixture (nothing includes it, so no database gains a table).
@part
@mixin(() => [RouteProbeMixin])
class RouteProbeEntity_Address extends Entity {
    @backReference
    owner: Lite<RouteProbeEntity>;
    city: string;
}

// A collection element carrying a mixin — eastwind's `OrderLineEntity` + `OrderDetailMixin` in miniature,
// which is the shape the round-trip below is really about.
@part
@mixin(() => [RouteProbeMixin])
class RouteProbeEntity_Tag extends Entity {
    @backReference
    owner: Lite<RouteProbeEntity>;
    label: string;
}

@reflect
class RouteProbeMixin extends MixinEntity {
    note: string | null;
}

@reflect
class RouteProbeEntity extends Entity {
    shipAddress: RouteProbeEntity_Address;
    tags: RouteProbeEntity_Tag[];
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

    // The enforcement point is the CONSTRUCTOR: a part root cannot be built at all, so there is no way
    // to end up holding a second name for a member.
    test("a @part cannot be the root of a route", () => {
        assert.throws(() => PropertyRoute.root(AlbumEntity_Song), /is a @part/);
        assert.throws(() => PropertyRoute.parse(AlbumEntity_Song, "name"), /is a @part/);
        // …and the owner-rooted spelling of the same member is the one that works.
        assert.equal(PropertyRoute.root(AlbumEntity).add("songs").add("Item").add("name").propertyString(),
            "songs/name");
    });

    // `rootStandalone` is the one deliberate way past it, for a part with no owner in the picture: the
    // reflection blob's label dictionary and a part's OWN registered query.
    test("rootStandalone builds one, and memberPaths uses it", () => {
        assert.equal(PropertyRoute.rootStandalone(AlbumEntity_Song).toString(), "(Album_Song)");
        assert.equal(PropertyRoute.rootStandalone(AlbumEntity), PropertyRoute.root(AlbumEntity));

        const paths = PropertyRoute.memberPaths(AlbumEntity_Song);
        assert.ok(paths.includes("name"), paths.join(", "));
        // Its OWN paths, so the label dictionary can key `AlbumEntity_Song.name` — which is what
        // FieldInfo.niceToString() reads.
        assert.ok(!paths.some(p => p.includes("/")), paths.join(", "));
    });

    // assertNotPartRoot is still what a STORAGE boundary asks, since a route can be handed to it from
    // anywhere — including `rootStandalone`.
    test("assertNotPartRoot refuses a standalone part root and passes an owner-rooted one", () => {
        assert.throws(() => PropertyRoute.rootStandalone(AlbumEntity_Song).add("name").assertNotPartRoot(), /@part/);
        PropertyRoute.root(AlbumEntity).add("songs").add("Item").add("name").assertNotPartRoot();
    });
});

describe("PropertyRoute — mixins", () => {
    // `propertyString()` writes a mixin step as `[MixinName]`, so `parse` must read one back: the stored
    // path IS what this class emitted, and the routes table, a property rule, a translated instance, a
    // tour's css step and the help page all hand it straight back. It used to throw
    // ("'[OrderDetailMixin]' does not exist on OrderLineEntity"), which took out the whole help page of
    // any type with a mixin on a part row.
    test("a [Mixin] step parses back", () => {
        const pr = PropertyRoute.parse(RouteProbeEntity, "tags/[RouteProbeMixin].note");
        assert.equal(pr.propertyString(), "tags/[RouteProbeMixin].note");
        assert.equal(pr.parent!.propertyRouteType, PropertyRouteType.Mixin);
    });

    // A mixin carries no dot before it, so the segment it sits in has to be split on the BRACKET too —
    // Signum's splitMixin, the level altea's one-pass splitter lacked. Without it `shipAddress[…]` is one
    // unresolvable member.
    test("a mixin mid-segment splits from its member", () => {
        assert.equal(PropertyRoute.parse(RouteProbeEntity, "shipAddress[RouteProbeMixin].note").propertyString(),
            "shipAddress[RouteProbeMixin].note");
    });

    // The invariant, over the whole generated set: whatever a type's routes print as, they parse back to.
    test("every generated route round-trips", () => {
        const routes = PropertyRoute.generateRoutes(RouteProbeEntity, true);
        assert.ok(routes.some(r => r.propertyString().includes("[")), "the fixture should produce mixin routes");
        for (const r of routes) {
            const s = r.propertyString();
            assert.equal(PropertyRoute.parse(RouteProbeEntity, s).propertyString(), s);
        }
    });

    test("an undeclared mixin says so", () => {
        assert.throws(() => PropertyRoute.parse(RouteProbeEntity, "[NoSuchMixin].note"), /Mixin 'NoSuchMixin' does not exist/);
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

// NEW here — Signum has no cast STEP, because it needs none: a member of a polymorphic reference's
// implementation is a route rooted at that implementation. altea cannot say that for a `@part`
// implementation, so the cast is a step that CONTINUES the owner (and a plain re-root for anything else).
describe("PropertyRoute — casts", () => {
    const contentRoute = () => PropertyRoute.root(CastProbeEntity).add("panels").add("Item").add("content");

    test("a cast to a @part CONTINUES the owner's route", () => {
        const pr = contentRoute().addCast(CastProbeTextPartEntity);
        assert.equal(pr.propertyRouteType, PropertyRouteType.Cast);
        assert.equal(pr.rootType, CastProbeEntity);
        assert.equal(pr.propertyString(), "panels/content.(CastProbeTextPart)");

        const member = pr.add("textContent");
        assert.equal(member.rootType, CastProbeEntity);
        assert.equal(member.propertyString(), "panels/content.(CastProbeTextPart).textContent");
        assert.equal(member.toString(), "(CastProbe).panels/content.(CastProbeTextPart).textContent");
        assert.equal(member.type.typeName, "String");
        // Rooted at the OWNER, so it is a route a storage boundary accepts — which is the whole point.
        member.assertNotPartRoot();
    });

    test("a cast to a NON-part re-roots, as Signum's AddImp does", () => {
        const pr = contentRoute().addCast(LabelEntity);
        assert.equal(pr.propertyRouteType, PropertyRouteType.Root);
        assert.equal(pr, PropertyRoute.root(LabelEntity));
        assert.equal(pr.add("name").propertyString(), "name");
    });

    test("the (CleanName) spelling parses back, and is AsTypeToken's key", () => {
        const path = "panels/content.(CastProbeTextPart).textContent";
        assert.equal(PropertyRoute.parse(CastProbeEntity, path).propertyString(), path);
        assert.equal(PropertyRoute.parseFull("(CastProbe)." + path).propertyString(), path);
    });

    test("casting to a type the reference does not implement says so", () => {
        assert.throws(() => contentRoute().addCast(AlbumEntity), /is not an implementation of/);
        assert.throws(() => PropertyRoute.parse(CastProbeEntity, "panels/content.(NoSuchType)"), /is not recognized/);
    });

    test("casting something that is not an entity reference says so", () => {
        assert.throws(() => PropertyRoute.root(CastProbeEntity).add("panels").add("Item").add("title").addCast(LabelEntity),
            /is not an entity reference/);
    });

    test("navigating a member WITHOUT casting still refuses", () => {
        assert.throws(() => contentRoute().add("textContent"), /Cast first/);
    });

    test("simplifyToPropertyOrRoot climbs out of a cast", () => {
        const pr = contentRoute().addCast(CastProbeTextPartEntity);
        assert.equal(pr.simplifyToPropertyOrRoot().propertyString(), "panels/content");
    });

    // The same rule the token layer applies (`subTokensBase` filters parts out of the byAll cast list):
    // "any entity" gives the step no owner to continue from, so a part cast there would claim a member
    // of a part that is not that route's part. A NON-part cast off a byAll is fine — it re-roots.
    test("a part cast is REFUSED on an @implementedByAll, a non-part cast is not", () => {
        const lastAward = PropertyRoute.root(ArtistEntity).add("lastAward");
        assert.equal(lastAward.getImplementations().isByAll, true);
        assert.throws(() => lastAward.addCast(CastProbeTextPartEntity), /is not one owner/);
        assert.equal(lastAward.addCast(LabelEntity), PropertyRoute.root(LabelEntity));
    });
});


describe("PropertyRoute — generateRoutes and casts", () => {
    const paths = (includeCasts: boolean): string[] =>
        PropertyRoute.generateRoutes(CastProbeEntity, true, includeCasts).map(r => r.propertyString());

    test("OFF by default: the route stops at the polymorphic reference, as Signum's does", () => {
        const off = paths(false);
        assert.ok(off.includes("panels/content"), off.join(", "));
        assert.ok(!off.some(p => p.includes("(")), off.join(", "));
    });

    test("ON: each @part implementation's members become routes of the OWNER", () => {
        const on = paths(true);
        assert.ok(on.includes("panels/content.(CastProbeTextPart).textContent"), on.join(", "));
        assert.ok(on.includes("panels/content.(CastProbeImagePart).imageUrl"), on.join(", "));
    });

    test("ON: the BARE cast route is not emitted — a cast is a navigation step, not a member", () => {
        const on = paths(true);
        assert.ok(!on.includes("panels/content.(CastProbeTextPart)"), on.join(", "));
    });

    test("ON: a NON-part implementation contributes nothing — its routes are its own root's", () => {
        const on = paths(true);
        assert.ok(!on.some(p => p.includes("(Label)")), on.join(", "));
    });

    test("ON: the part's BOOKKEEPING is skipped, as for a part reached by continuation", () => {
        const on = paths(true);
        for (const bookkeeping of ["id", "ticks"])
            assert.ok(!on.includes("panels/content.(CastProbeTextPart)." + bookkeeping), on.join(", "));
    });

    test("ON: every generated route still round-trips through parse", () => {
        for (const p of paths(true))
            assert.equal(PropertyRoute.parse(CastProbeEntity, p).propertyString(), p);
    });

    // LEGACY MODE: a cast route is an altea EXTENSION of the stored grammar, so a Signum database has no
    // counterpart for one and Signum's own synchronizer would delete it. GENERATION is suppressed;
    // parsing is not, so a path already stored still reads back whichever mode is on.
    test("LEGACY MODE generates no cast route, but still parses one", () => {
        setLegacyPropertyPaths(true);
        try {
            const legacy = PropertyRoute.generateRoutes(CastProbeEntity, true, true).map(r => r.propertyString());
            assert.ok(!legacy.some(p => p.includes("(")), legacy.join(", "));
            assert.equal(
                PropertyRoute.parse(CastProbeEntity, "Panels/Content.(CastProbeTextPart).TextContent").propertyString(),
                "Panels/Content.(CastProbeTextPart).TextContent");
        } finally {
            setLegacyPropertyPaths(false);
        }
    });
});
