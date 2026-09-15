import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { init, reflect } from "@altea/altea/data/reflection";
import { Entity, ModelEntity } from "@altea/altea/data/entity";
import type { ConstructSymbol, From, ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { ReflectionServer } from "@altea/altea/server/reflectionServer";
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
        // An enum has no class to hang a TypeInfo on, but it does get a metadata entry — with its members'
        // database ids, so the client can address one without a round trip.
        assert.equal(types["AlbumState"].kind, "Enum");
        assert.equal(types["AlbumState"].fields["Saved"].id, AlbumState.Saved);
    });

    test("an embedded's members appear DOTTED under each owning entity (Signum's GenerateRoutes)", () => {
        // `bonusTrack` is an EMBEDDED, so its members are routes of AlbumEntity — which is exactly how the
        // property rules are keyed. (`label` is an entity REFERENCE: it re-roots, so LabelEntity's members
        // are its own routes, not the album's.)
        loadSignumTranslations("en", `<?xml version="1.0" encoding="utf-8"?>
            <Translations>
              <Type Name="AlbumEntity">
                <Member Name="BonusTrack.Name" Description="Bonus track title" />
              </Type>
            </Translations>`);
        const album = ReflectionServer.buildMetadata("en").types["AlbumEntity"];
        assert.equal(album.fields["bonusTrack.name"]?.niceName, "Bonus track title");
        assert.equal(album.fields["label.name"], undefined);
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
