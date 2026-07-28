import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import "@altea/altea/react/EntityTypeApi"; // installs the token / findOptions statics onto the entity classes
import { QueryTokenString } from "@altea/altea/react/QueryTokenString";
import type { FilterOperation, OrderType } from "@altea/altea/entities/dynamicQueries";
import { ArtistEntity } from "../../entities/music";

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

  test("findOptions(token => ...) roots queryName at the type and builds the options", () => {
    const fo = ArtistEntity.findOptions(token => ({
      filterOptions: [token(a => a.name).filter("EqualTo", "AC/DC")],
      orderOptions: [token(a => a.name).order("Ascending")],
      columnOptions: [token(a => a.id), token(a => a.name).column("The name")],
    }));

    assert.equal(fo.queryName, ArtistEntity);
    const f0 = fo.filterOptions![0] as { token: QueryTokenString<any>; operation: FilterOperation; value: unknown };
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
