import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { MixinEntity } from "@altea/altea/entities/entity";
import { cleanModified, isModifiedSelf, isGraphModified } from "@altea/altea/entities/changes";
import { Temporal } from "@altea/altea/entities/basics";
import { CorruptMixin } from "@altea/altea/entities/corruptMixin";
import { reflect } from "@altea/altea/entities/reflection";
import { hasDb, start } from "./setup";
import {
    NoteWithDateEntity, ColaboratorsMixin, ArtistEntity, CountryEntity, Sex,
} from "../entities/music";

// End-to-end proof of the mixin pattern: @mixin(() => [...]) on an entity + the
// `.mixin<M>()` accessor, both IN MEMORY (no database) and IN QUERIES (live, DB-gated).
// NoteWithDateEntity declares @mixin(() => [ColaboratorsMixin, CorruptMixin]); altea folds
// a mixin's fields flat onto the owner, so `.mixin(M)` is a typed cast that also asserts M
// is declared. Faithful ports of Signum's SelectTest mixin cases live in select.test.ts;
// this file is the dedicated, self-contained mixin exercise the roadmap calls for.

// A mixin that is never declared on any entity — used to assert the undeclared-mixin guard.
@reflect
class UndeclaredMixin extends MixinEntity {
    flag: boolean = false;
}

function makeCountry(id: number, name: string): CountryEntity {
    const c = CountryEntity.create({ name });
    c.id = id; c.isNew = false; c.ticks = 0; cleanModified(c);
    return c;
}

function makeNote(): NoteWithDateEntity {
    return NoteWithDateEntity.create({
        title: "hello", text: "body",
        target: makeCountry(1, "USA"),
        otherTarget: null,
        creationTime: Temporal.PlainDateTime.from("2020-01-02T03:04:05"),
        creationDate: Temporal.PlainDate.from("2020-01-02"),
        releaseDate: null,
    });
}

describe("Mixin (in memory)", () => {

    // create() seeds declared mixin fields with their initializer defaults (altea inlines
    // mixin fields onto the entity, so `new Entity()` alone would skip their initializers).
    test("create seeds declared mixin field defaults", () => {
        const note = makeNote();
        assert.equal(note.mixin(CorruptMixin).corrupt, false);   // CorruptMixin.corrupt = false
    });

    // `.mixin(M)` is a typed cast: it returns the very same entity instance, and reads/writes
    // to the mixin's (flattened) fields go straight through to the owner.
    test("mixin() is a cast to the same instance and exposes mixin fields", () => {
        const note = makeNote();
        assert.equal(note.mixin(CorruptMixin), note as unknown as CorruptMixin);

        note.mixin(CorruptMixin).corrupt = true;
        assert.equal((note as unknown as CorruptMixin).corrupt, true);
        assert.equal(note.mixin(CorruptMixin).corrupt, true);
    });

    // The guard: calling `.mixin(M)` for a mixin that is not declared on the entity throws,
    // instead of silently returning `this` cast to M and reading phantom fields.
    test("mixin() throws for a mixin not declared on the entity", () => {
        const note = makeNote();
        assert.throws(() => note.mixin(UndeclaredMixin), /UndeclaredMixin.*not declared on.*NoteWithDate/);

        // CorruptMixin is real, but ArtistEntity does not declare it.
        const artist = ArtistEntity.create({ name: "A", dead: false, sex: Sex.Male, status: null, lastAward: null, friends: [] });
        assert.throws(() => artist.mixin(CorruptMixin), /CorruptMixin.*not declared on.*Artist/);
    });

    // Mixin fields participate in snapshot change tracking: editing one marks the OWNER
    // self-modified (their columns are folded into the owner's row image).
    test("editing a mixin field marks the owner self-modified", () => {
        const note = makeNote();
        note.id = "11111111-1111-1111-1111-111111111111"; note.isNew = false; note.ticks = 0;
        cleanModified(note);
        assert.equal(isModifiedSelf(note), false);
        assert.equal(isGraphModified(note), false);

        note.mixin(CorruptMixin).corrupt = true;
        assert.equal(isModifiedSelf(note), true);
    });
});

// Live mixin usage through the query provider — the binder resolves `entity.mixin(M).field`
// against the mixin's columns (folded into the owner table). Gated on ALTEA_TEST_DB.
describe("Mixin (in queries)", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Project a mixin field: Select(a => a.Mixin<CorruptMixin>().Corrupt).
    test("projects a mixin field", async () => {
        const list = await table(NoteWithDateEntity).map(a => a.mixin(CorruptMixin).corrupt).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(c => typeof c === "boolean"));
    });

    // Filter on a mixin field: Where(a => a.Mixin<CorruptMixin>().Corrupt == true).
    test("filters on a mixin field", async () => {
        const list = await table(NoteWithDateEntity)
            .filter(a => a.mixin(CorruptMixin).corrupt == true)
            .toArray();
        assert.ok(list.every(n => n.mixin(CorruptMixin).corrupt === true));
    });

    // Flatten a mixin collection: from n from c in n.Mixin<ColaboratorsMixin>().Colaborators.
    test("flattens a mixin collection", async () => {
        const result = await table(NoteWithDateEntity)
            .flatMap(n => n.mixin(ColaboratorsMixin).colaborators)
            .toArray();
        assert.ok(result.every(c => c.colaborator instanceof ArtistEntity));
    });

    // Projecting a whole mixin (detached from its main entity) is rejected — mirrors Signum.
    test("projecting a whole mixin throws", async () => {
        await assert.rejects(
            async () => table(NoteWithDateEntity).map(a => a.mixin(CorruptMixin)).toArray(),
            /without their main entity/);
    });
});
