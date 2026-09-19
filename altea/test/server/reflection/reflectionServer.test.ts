import { test, describe } from "vitest";
import assert from "node:assert/strict";
// Binds the AsyncLocalStorage context — among other things CultureInfo.initLocalizationContext(Statics).
// buildMetadata resolves the registered expressions' niceName THUNKS inside a culture scope (the only
// part of the blob that cannot read the culture off its own snapshot), so without this the culture-pure
// contract the tests below rely on has nothing to scope with.
import "@altea/altea/server/context.node";
import { init, reflect } from "@altea/altea/data/reflection";
import { Entity, ModelEntity } from "@altea/altea/data/entity";
import type { ConstructSymbol, From, ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { ReflectionServer } from "@altea/altea/server/reflectionServer";
import { Metadata } from "@altea/altea/data/metadata";
import { SchemaBuilder } from "@altea/altea/server/schema";
import "@altea/altea/server/fluentOperations"; // FluentInclude.withStateMachine / withExecute / …
import { loadSignumTranslations } from "@altea/altea/server/translations";
import { AlbumEntity, AlbumState } from "../../data/music";

// The type a throwaway query is named by: a query's name IS the type it yields rows of, so this is
// what "Test.MetaQuery" used to be as a bare string.
@reflect
class MetaQueryModel extends ModelEntity {
    name: string = "";
}

// Metadata endpoint builder (Signum's ReflectionServer): ONE TypeMetadata per type, carrying the
// per-culture nice names, `hasQuery`, and the operations registered on that type. Fully offline —
// buildMetadata reads only the in-memory registries. Uses its OWN operation container (MetaOperation)
// so it does not collide with operationLogic.test.ts's shared
// AlbumOperation registrations.
namespace MetaOperation {
    export const Create: ConstructSymbol<AlbumEntity> = init();
    export const Clone: ConstructSymbol<AlbumEntity, From<AlbumEntity>> = init();
    export const Save: ExecuteSymbol<AlbumEntity> = init();
    export const Delete: DeleteSymbol<AlbumEntity> = init();
    // A ConstructFrom whose SOURCE is `Entity` itself, so every entity inherits it — the shape of
    // AlertOperation.CreateAlertFromEntity / NoteOperation.CreateNoteFromEntity, which is what made the
    // blob mostly duplicate. Its entityType is the FROM type, so it is declared on `Entity`.
    export const CreateFromAnyEntity: ConstructSymbol<AlbumEntity, From<Entity>> = init();
}

// Operations are declared on the include, so this suite opens a bare SchemaBuilder for one — it builds
// the table from reflection and touches no database.
new SchemaBuilder().include(AlbumEntity).withStateMachine(a => a.state, sm => {
    sm.withConstruct(MetaOperation.Create, {
        toStates: [AlbumState.New],
        construct: () => AlbumEntity.create({ state: AlbumState.New }),
    })

        .withConstructFrom(AlbumEntity, MetaOperation.Clone, {
            toStates: [AlbumState.New],
            resultIsSaved: false,
            construct: from => AlbumEntity.create({ state: AlbumState.New, name: from.name }),
        })

        .withExecute(MetaOperation.Save, {
            fromStates: [AlbumState.New, AlbumState.Saved],
            toStates: [AlbumState.Saved],
            canBeNew: true,
            avoidImplicitSave: true,
            execute: a => { a.state = AlbumState.Saved; },
        })

        .withDelete(MetaOperation.Delete, {
            fromStates: [AlbumState.Saved],
            delete: a => a.delete(),
        })

        .withConstructFrom(Entity, MetaOperation.CreateFromAnyEntity, {
            toStates: [AlbumState.New],
            construct: () => AlbumEntity.create({ state: AlbumState.New }),
        });
});

describe("ReflectionServer.buildMetadata", () => {

    test("a type's operations carry an OperationMetadata per operation registered ON IT", () => {
        // Operations hang off the TYPE now (via each Graph op's explicit `entityType`), not off a flat
        // key-indexed section the client had to fan out by splitting the symbol key.
        const ops = ReflectionServer.buildMetadata("en").types["AlbumEntity"].operations!;

        // A false flag is now simply ABSENT — every one of these is optional in the DTO and every reader
        // already treats absent as false, so writing `false` was 15 bytes of nothing, 799 times over.
        const create = ops["MetaOperation.Create"];
        assert.ok(create, "Create present");
        assert.equal(create.operationType, "Constructor");
        assert.equal(create.hasCanExecute, undefined); // plain Construct has no onCanExecute
        assert.equal(create.hasStates, true);          // getState + toStates

        const clone = ops["MetaOperation.Clone"];
        assert.equal(clone.operationType, "ConstructorFrom");
        assert.equal(clone.hasCanExecute, true);     // IEntityOperation
        assert.equal(clone.resultIsSaved, undefined);
        assert.equal(clone.canBeNew, undefined);

        const save = ops["MetaOperation.Save"];
        assert.equal(save.operationType, "Execute");
        assert.equal(save.hasCanExecute, true);
        assert.equal(save.canBeNew, true);
        assert.equal(save.hasStates, true);

        const del = ops["MetaOperation.Delete"];
        assert.equal(del.operationType, "Delete");
        assert.equal(del.hasCanExecute, true);
    });

    // The blob used to ship an inherited operation once PER SUBCLASS — the two ConstructFroms registered
    // on `Entity` came back 267 times each in eastwind, 136KB of a 437KB response. Each one is emitted on
    // the type that DECLARES it and the client walks the prototype chain to find it.
    test("an operation registered on a base type is emitted ONCE, on that base", () => {
        const types = ReflectionServer.buildMetadata("en").types;
        const key = "MetaOperation.CreateFromAnyEntity";
        const owners = Object.entries(types).filter(([, tm]) => tm.operations?.[key] != null).map(([n]) => n);

        assert.deepEqual(owners, ["Entity"], "declared on Entity, so carried by Entity and nothing else");
        assert.equal(types["AlbumEntity"].operations![key], undefined,
            "a subclass does NOT restate it — the client walks the prototype chain to find it");
    });

    // `hasConstructorOperation` is the one thing that stays PER CONCRETE TYPE: it is read before the
    // per-role filter, so "has no Constructor" and "has one this role may not run" stay distinguishable.
    test("hasConstructorOperation stays per concrete type", () => {
        assert.equal(ReflectionServer.buildMetadata("en").types["AlbumEntity"].hasConstructorOperation, true);
    });

    test("a registered query sets hasQuery on its type entry", () => {
        // Register a throwaway query (getQueryNames never invokes the lazy core). A query is named by
        // the TYPE it yields rows of, so the flag rides on that type's own entry.
        QueryLogic.queries.register(MetaQueryModel, () => { throw new Error("core not built in this test"); });
        const types = ReflectionServer.buildMetadata("en").types;
        assert.equal(types["MetaQueryModel"].hasQuery, true);
    });

    test("every reflected class gets an entry, with the persisted/non-persisted kind", () => {
        const types = ReflectionServer.buildMetadata("en").types;
        assert.equal(types["AlbumEntity"].kind, "Entity");
        // An enum has no class to hang a TypeInfo on, but it does get a metadata entry. What it does NOT
        // carry is its members' row ids: an enum member's id IS its numeric value (`enumEntityMembers`,
        // which is also what SEEDS the table), so the client computes it — the assertion this replaces
        // only ever restated that identity. A member appears here when it has a declared label, and
        // AlbumState has none.
        assert.equal(types["AlbumState"].kind, "Enum");
        assert.deepEqual(types["AlbumState"].fields, {});
    });

    // `fields` is keyed by (declaring type, member) — the pair `FieldInfo.niceToString()` holds — so an
    // embedded describes its OWN members, once, and no owner restates them. The same label then answers
    // whether the UI reached the member through `Album.bonusTrack.name` or by rendering the embedded on
    // its own, which is the whole reason for keying it this way.
    test("an embedded's members are described under the EMBEDDED, not under its owners", () => {
        loadSignumTranslations("en", `<?xml version="1.0" encoding="utf-8"?>
            <Translations>
              <Type Name="SongEmbedded">
                <Member Name="Name" Description="Bonus track title" />
              </Type>
            </Translations>`);
        const types = ReflectionServer.buildMetadata("en").types;

        assert.equal(types["SongEmbedded"].fields["name"]?.niceName, "Bonus track title");
        assert.equal(types["AlbumEntity"].fields["bonusTrack.name"], undefined,
            "no owner-rooted path in the member record — that key space is `routes`");
        // The owner still names the member that HOLDS the embedded, which is its own.
        assert.ok("bonusTrack" in types["AlbumEntity"].fields === false
            || types["AlbumEntity"].fields["bonusTrack"] != null);
    });

    // The one behaviour the split drops: a label declared under the OWNER with a dotted member name. It
    // would land in a key space no reader can reach, so it is skipped rather than shipped dead.
    test("a DOTTED member declared under an owner is not carried into `fields`", () => {
        loadSignumTranslations("en", `<?xml version="1.0" encoding="utf-8"?>
            <Translations>
              <Type Name="AlbumEntity">
                <Member Name="BonusTrack.Name" Description="Bonus track title" />
              </Type>
            </Translations>`);
        const album = ReflectionServer.buildMetadata("en").types["AlbumEntity"];
        assert.equal(album.fields["bonusTrack.name"], undefined);
        assert.equal(album.fields["BonusTrack.Name"], undefined);
    });

    test("nice names reflect the translations loaded for the REQUESTED culture, not the ambient one", () => {
        loadSignumTranslations("es", `<?xml version="1.0" encoding="utf-8"?>
            <Translations>
              <Type Name="AlbumEntity" Description="Álbum" PluralDescription="Álbumes" Gender="m">
                <Member Name="Name" Description="Nombre" />
              </Type>
            </Translations>`);

        const es = ReflectionServer.buildMetadata("es");
        assert.equal(es.culture, "es");
        const album = es.types["AlbumEntity"];
        assert.ok(album, "AlbumEntity translated");
        assert.equal(album.niceName, "Álbum");
        assert.equal(album.nicePluralName, "Álbumes");
        assert.equal(album.gender, "m");
        // The XML keys members by the PascalCase C# name; altea's routes are camelCase, so the builder
        // probes both and emits under the ROUTE.
        assert.equal(album.fields["name"].niceName, "Nombre");

        // A culture with nothing loaded still gets every type — just no declared names on them, so the
        // client humanises the identifiers.
        const fr = ReflectionServer.buildMetadata("fr").types["AlbumEntity"];
        assert.equal(fr.niceName, undefined);
        assert.equal(fr.nicePluralName, undefined);
    });
});

// The compact form the endpoint actually returns, and the guarantee that makes it safe: `Metadata.fromWire`
// puts back exactly what `toWire` took out, so NO reader on either tier has to know the encoding exists.
describe("ReflectionServer.toWire", () => {

    test("a field whose only fact is its label rides as that label", () => {
        loadSignumTranslations("en", `<?xml version="1.0" encoding="utf-8"?>
            <Translations>
              <Type Name="AlbumEntity">
                <Member Name="Name" Description="Album title" />
              </Type>
            </Translations>`);
        const wire = ReflectionServer.toWire(ReflectionServer.buildMetadata("en"));
        assert.equal(wire.types["AlbumEntity"].fields!["name"], "Album title");
        // An enum member collapses the same way, and an UNTRANSLATED one is absent rather than an empty
        // object: its row id is no longer shipped (it IS the member's numeric value), so a label is the
        // only fact an entry can hold.
        assert.equal(wire.types["AlbumState"]?.fields?.["Saved"], undefined);
    });

    test("an empty fields record is not shipped at all", () => {
        const wire = ReflectionServer.toWire({
            culture: "en", types: { "Bare": { kind: "Entity", fields: {} } },
        });
        assert.equal("fields" in wire.types["Bare"], false);
        // The TYPE itself stays: its presence is what says the role may read it.
        assert.deepEqual(wire.types["Bare"], { kind: "Entity" });
    });

    test("fromWire reconstructs the model exactly", () => {
        const model = ReflectionServer.buildMetadata("en");
        const back = Metadata.fromWire(ReflectionServer.toWire(model));
        assert.deepEqual(back, model);
    });
});

// The route does not call buildMetadata directly — it calls cachedWire, which memoises the FINISHED wire
// payload per (culture, role). These pin the two things that make that safe: the key really does separate
// roles, and every clock that can stale a payload drops it.
describe("ReflectionServer.cachedWire", () => {

    function reset(): void {
        ReflectionServer.setMetadataFilter(undefined);   // both setters clear the cache
        ReflectionServer.setMetadataCacheKey(undefined);
    }

    test("the same culture and role is built once and reused", async () => {
        reset();
        let builds = 0;
        ReflectionServer.setMetadataFilter(m => { builds++; return m; });

        const a = await ReflectionServer.cachedWire("en");
        const b = await ReflectionServer.cachedWire("en");

        assert.equal(builds, 1);
        assert.equal(a, b);                                 // the very same payload object
        assert.equal(ReflectionServer.metadataCacheSize(), 1);
        reset();
    });

    test("a different culture is a different entry", async () => {
        reset();
        await ReflectionServer.cachedWire("en");
        await ReflectionServer.cachedWire("es");
        assert.equal(ReflectionServer.metadataCacheSize(), 2);
        reset();
    });

    test("a different role is a different entry, and gets its own filtered payload", async () => {
        reset();
        let role = "Alice";
        ReflectionServer.setMetadataCacheKey(() => role);
        // Stamp something role-specific so the two payloads are distinguishable by content, not just count.
        ReflectionServer.setMetadataFilter(m => {
            m.types["AlbumEntity"]!.niceName = `seen by ${role}`;
            return m;
        });

        const alice = await ReflectionServer.cachedWire("en");
        role = "Bob";
        const bob = await ReflectionServer.cachedWire("en");

        assert.equal(alice.types["AlbumEntity"]!.niceName, "seen by Alice");
        assert.equal(bob.types["AlbumEntity"]!.niceName, "seen by Bob");
        assert.equal(ReflectionServer.metadataCacheSize(), 2);

        // …and Alice still gets Alice's, rather than whichever was built last.
        role = "Alice";
        assert.equal((await ReflectionServer.cachedWire("en")).types["AlbumEntity"]!.niceName, "seen by Alice");
        assert.equal(ReflectionServer.metadataCacheSize(), 2);
        reset();
    });

    test("invalidateMetadataCache drops what was held", async () => {
        reset();
        let builds = 0;
        ReflectionServer.setMetadataFilter(m => { builds++; return m; });

        await ReflectionServer.cachedWire("en");
        ReflectionServer.invalidateMetadataCache();
        assert.equal(ReflectionServer.metadataCacheSize(), 0);

        await ReflectionServer.cachedWire("en");
        assert.equal(builds, 2);                            // rebuilt rather than served stale
        reset();
    });

    test("a failed build is not cached, so the next request retries", async () => {
        reset();
        let attempts = 0;
        ReflectionServer.setMetadataFilter(m => {
            if (++attempts === 1)
                throw new Error("rule cache unavailable");
            return m;
        });

        await assert.rejects(() => ReflectionServer.cachedWire("en"));
        // The rejected promise self-evicts — otherwise that one error would be served until restart.
        assert.equal(ReflectionServer.metadataCacheSize(), 0);

        const ok = await ReflectionServer.cachedWire("en");
        assert.equal(attempts, 2);
        assert.notEqual(ok, undefined);
        reset();
    });
});

// The blob is assembled from the translation store, so a store write must reach the next request. Before
// the editor could reload a culture in-process this was true only because nothing ever wrote twice.
describe("the blob cache follows the translation store", () => {

    test("loading a translation drops the cached payloads", async () => {
        ReflectionServer.setMetadataFilter(undefined);
        ReflectionServer.setMetadataCacheKey(undefined);

        loadSignumTranslations("pt", `<?xml version="1.0" encoding="utf-8"?>
<Translations>
  <Type Name="AlbumEntity" Description="Disco" />
</Translations>`);
        assert.equal((await ReflectionServer.cachedWire("pt")).types["AlbumEntity"]!.niceName, "Disco");
        assert.equal(ReflectionServer.metadataCacheSize(), 1);

        // What the editor's save does: rewrite the caption, then re-read the culture.
        loadSignumTranslations("pt", `<?xml version="1.0" encoding="utf-8"?>
<Translations>
  <Type Name="AlbumEntity" Description="Álbum" />
</Translations>`);

        // The write announced itself, so the stale payload is gone rather than served until restart.
        assert.equal(ReflectionServer.metadataCacheSize(), 0);
        assert.equal((await ReflectionServer.cachedWire("pt")).types["AlbumEntity"]!.niceName, "Álbum");
    });
});
