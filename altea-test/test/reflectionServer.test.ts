import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { init } from "@altea/altea/data/reflection";
import type { ConstructSymbol, From, ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { graph } from "@altea/altea/server/graphBuilder";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { ReflectionServer } from "@altea/altea/server/reflectionServer";
import { loadSignumTranslations } from "@altea/altea/server/translations";
import { AlbumEntity, AlbumState } from "../entities/music";

// Metadata endpoint builder (Signum's ReflectionServer): the runtime/culture-dependent blob
// (translations + queries + operations). Fully offline — buildMetadata reads only the in-memory
// registries. Uses its OWN operation container (MetaOperation) so, under --test-isolation=none, it
// does not collide with operationLogic.test.ts's shared AlbumOperation registrations.
namespace MetaOperation {
    export const Create: ConstructSymbol<AlbumEntity> = init();
    export const Clone: ConstructSymbol<AlbumEntity, From<AlbumEntity>> = init();
    export const Save: ExecuteSymbol<AlbumEntity> = init();
    export const Delete: DeleteSymbol<AlbumEntity> = init();
}

const MetaGraph = graph(AlbumEntity, AlbumState, g => {
    g.GetState = a => a.state;
    g.Construct(MetaOperation.Create, {
        toStates: [AlbumState.New],
        construct: () => AlbumEntity.create({ state: AlbumState.New }),
    });
    g.ConstructFrom(MetaOperation.Clone, {
        toStates: [AlbumState.New],
        resultIsSaved: false,
        construct: from => AlbumEntity.create({ state: AlbumState.New, name: from.name }),
    });
    g.Execute(MetaOperation.Save, {
        fromStates: [AlbumState.New, AlbumState.Saved],
        toStates: [AlbumState.Saved],
        canBeNew: true,
        avoidImplicitSave: true,
        execute: a => { a.state = AlbumState.Saved; },
    });
    g.Delete(MetaOperation.Delete, {
        fromStates: [AlbumState.Saved],
        delete: a => a.delete(),
    });
});
MetaGraph.register();

describe("ReflectionServer.buildMetadata", () => {

    test("operations section carries an OperationInfo per registered operation", () => {
        const ops = ReflectionServer.buildMetadata("en").operations;

        const create = ops["MetaOperation.Create"];
        assert.ok(create, "Create present");
        assert.equal(create.operationType, "Constructor");
        assert.equal(create.hasCanExecute, false); // plain Construct has no onCanExecute
        assert.equal(create.hasStates, true);       // getState + toStates

        const clone = ops["MetaOperation.Clone"];
        assert.equal(clone.operationType, "ConstructorFrom");
        assert.equal(clone.hasCanExecute, true);     // IEntityOperation
        assert.equal(clone.resultIsSaved, false);
        assert.equal(clone.canBeNew, false);

        const save = ops["MetaOperation.Save"];
        assert.equal(save.operationType, "Execute");
        assert.equal(save.hasCanExecute, true);
        assert.equal(save.canBeNew, true);
        assert.equal(save.hasStates, true);

        const del = ops["MetaOperation.Delete"];
        assert.equal(del.operationType, "Delete");
        assert.equal(del.hasCanExecute, true);
    });

    test("queries section lists the registered query keys", () => {
        // Register a throwaway query (getQueryNames never invokes the lazy core).
        QueryLogic.queries.register("Test.MetaQuery", () => { throw new Error("core not built in this test"); });
        const meta = ReflectionServer.buildMetadata("en");
        assert.ok(meta.queries.includes("Test.MetaQuery"));
    });

    test("translations section reflects the loaded LocalizedTypes for the requested culture", () => {
        loadSignumTranslations("es", `<?xml version="1.0" encoding="utf-8"?>
            <Translations>
              <Type Name="AlbumEntity" Description="Álbum" PluralDescription="Álbumes" Gender="m">
                <Member Name="Name" Description="Nombre" />
              </Type>
            </Translations>`);

        const es = ReflectionServer.buildMetadata("es");
        assert.equal(es.culture, "es");
        const album = es.translations["AlbumEntity"];
        assert.ok(album, "AlbumEntity translated");
        assert.equal(album.description, "Álbum");
        assert.equal(album.pluralDescription, "Álbumes");
        assert.equal(album.gender, "m");
        assert.equal(album.members["Name"], "Nombre");

        // A culture with nothing loaded gets an empty translations map (client falls back).
        assert.deepEqual(ReflectionServer.buildMetadata("fr").translations, {});
    });
});
