import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import "@altea/altea/client/EntityTypeApi"; // installs the token / findOptions statics onto the entity classes
import { QueryTokenString } from "@altea/altea/client/QueryTokenString";
import type { FilterOperationKeys, OrderTypeKeys } from "@altea/altea/data/dynamicQueries";
import { ArtistEntity, NoteWithDateEntity } from "../data/music";
import { CorruptMixin } from "@altea/altea/data/corruptMixin";

// Signum's Type<T>.token / findOptions family, in altea implemented as STATICS on the entity class
// (the class doubles as the Type descriptor). Verifies the namespace-merge augmentation binds `this`
// to the concrete type at runtime and the token builder produces the right token strings.

describe("Entity static Type<T> API", () => {
  test("token() is rooted at the entity; token(a => a.prop) builds a PascalCased token", () => {
    assert.ok(ArtistEntity.token() instanceof QueryTokenString);
    assert.equal(ArtistEntity.token().toString(), "");
    assert.equal(ArtistEntity.token(a => a.name).toString(), "Name");
    assert.equal(ArtistEntity.token<number>("SomeExpression").toString(), "SomeExpression");
  });

  // The two spellings of the `@valueField` hop, and that they are the SAME token. altea's collection
  // element is a `@part` ROW where Signum's `MList<Lite<Artist>>` element is the lite itself, so the
  // value Signum filters as `Friends.Any` is `Friends.Any.Friend` here — and the typed builder never
  // produces the bare quantifier as a value, because that token IS the row.
  test("any(lambda) is any().append(lambda) — the @valueField hop", () => {
    assert.equal(ArtistEntity.token(a => a.friends).any().append(f => f.friend).toString(), "Friends.Any.Friend");
    assert.equal(ArtistEntity.token(a => a.friends).any(f => f.friend).toString(), "Friends.Any.Friend");
    assert.equal(ArtistEntity.token(a => a.friends).any().toString(), "Friends.Any");

    assert.equal(ArtistEntity.token(a => a.friends).all(f => f.friend).toString(), "Friends.All.Friend");
    assert.equal(ArtistEntity.token(a => a.friends).notAny(f => f.friend).toString(), "Friends.NotAny.Friend");
    assert.equal(ArtistEntity.token(a => a.friends).notAll(f => f.friend).toString(), "Friends.NotAll.Friend");
    assert.equal(ArtistEntity.token(a => a.friends).element(1, f => f.friend).toString(), "Friends.Element.Friend");
    assert.equal(ArtistEntity.token(a => a.friends).element(2, f => f.friend).toString(), "Friends.Element2.Friend");
  });

  test("token(a => a.mixin(M).field) extracts the mixin step from the Quoted expression tree", () => {
    // Exercises getLambdaMembers' `.mixin(ctor)` ExCall handling: [Mixin CorruptMixin, Member corrupt].
    assert.equal(NoteWithDateEntity.token(a => a.mixin(CorruptMixin).corrupt).toString(), "CorruptMixin.Corrupt");
  });

  test("findOptions(token => ...) roots queryName at the type and builds the options", () => {
    const fo = ArtistEntity.findOptions(token => ({
      filterOptions: [token(a => a.name).filter("EqualTo", "AC/DC")],
      orderOptions: [token(a => a.name).order("Ascending")],
      columnOptions: [token(a => a.id), token(a => a.name).column("The name")],
    }));

    assert.equal(fo.queryName, ArtistEntity);
    const f0 = fo.filterOptions![0] as { token: QueryTokenString<any>; operation: FilterOperationKeys; value: unknown };
    assert.equal(f0.token.toString(), "Name");
    assert.equal(f0.operation, "EqualTo");
    assert.equal(f0.value, "AC/DC");
    assert.equal((fo.orderOptions![0] as { token: QueryTokenString<any> }).token.toString(), "Name");
    assert.equal((fo.columnOptions![0] as QueryTokenString<any>).toString(), "Id");
    assert.equal((fo.columnOptions![1] as { displayName?: string }).displayName, "The name");
  });

  test("findOptions() with no builder is just { queryName }", () => {
    assert.deepEqual(ArtistEntity.findOptions(), { queryName: ArtistEntity });
  });
});
