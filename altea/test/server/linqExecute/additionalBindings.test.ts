import { test, beforeAll, describe } from "vitest";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { Connector } from "@altea/altea/server/connection/connector";
import { Expression } from "@altea/altea/server/linq/expressions";
import { ClassType } from "@altea/altea/server/runtimeTypes";
import type { Entity, Type } from "@altea/altea/data/entity";
import type { AdditionalBindingSpec } from "@altea/altea/server/schema/entityEvents";
import { hasDb, start } from "../setup";
import { AlbumEntity, LabelEntity } from "../../data/music";

// An entity's additional binding (Signum's RegisterBinding) is folded into the SELECT that retrieves it.
// Its lambda may navigate REFERENCES: each join has to attach to the query — for the root `table(T)`
// source, where nothing else is on the binder's source stack yet, and for an entity completed through a
// reference, whose own join must be known before the binding navigates on from it.

describe.skipIf(!hasDb)("Additional bindings", () => {
    beforeAll(async () => { await start(); });

    async function withBinding<T extends Entity, R>(type: Type<T>, spec: AdditionalBindingSpec<T>, fn: () => Promise<R>): Promise<R> {
        const specs = Connector.current().schema.entityEvents(type).additionalBindings;
        specs.push(spec);
        try { return await fn(); }
        finally { specs.splice(specs.indexOf(spec), 1); }
    }

    test("on the root table, navigating two references", async () => {
        const seen = new Map<unknown, unknown>();
        const spec: AdditionalBindingSpec<AlbumEntity> = {
            valueLambda: Expression.fromQuotedLambda((a: AlbumEntity) => a.label.country.name, [new ClassType(AlbumEntity)]),
            set: (album, value) => seen.set(album.id, value),
        };

        await withBinding(AlbumEntity, spec, () => table(AlbumEntity).toArray());

        const expected = await table(AlbumEntity).map(a => ({ id: a.id, country: a.label.country.name })).toArray();
        assert.ok(expected.length > 0);
        for (const e of expected)
            assert.equal(seen.get(e.id), e.country);
    });

    test("on an entity completed through a reference", async () => {
        const seen = new Map<unknown, unknown>();
        const spec: AdditionalBindingSpec<LabelEntity> = {
            valueLambda: Expression.fromQuotedLambda((l: LabelEntity) => l.country.name, [new ClassType(LabelEntity)]),
            set: (label, value) => seen.set(label.id, value),
        };

        await withBinding(LabelEntity, spec, () => table(AlbumEntity).toArray());

        const expected = await table(AlbumEntity).map(a => ({ id: a.label.id, country: a.label.country.name })).toArray();
        assert.ok(expected.length > 0);
        for (const e of expected)
            assert.equal(seen.get(e.id), e.country);
    });
});
