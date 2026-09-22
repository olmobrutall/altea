import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { reflect } from "@altea/altea/data/reflection"; // anchor for the transformer's @field injection
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { entity } from "@altea/altea/data/decorators";
import { ClassType, LiteralType, RuntimeType } from "@altea/altea/server/runtimeTypes";
import { markStable, isQueryReadablePromise, stableRuntimeType } from "@altea/altea/server/stablePromise";
import "@altea/altea/server/table"; // installs `.$v` and `.thenTyped`

// `thenTyped` projects a stable promise onto one of its members and keeps it usable by `.$v`. The two
// properties that matter are the ones `.$v` checks, and neither fails loudly if it regresses — an unstable
// derivation is refused at fold time with a confusing message, and a mistyped one silently changes what a
// query token IS. So both are pinned here.

@reflect
class ThenMailConfig extends EmbeddedEntity {
    urlLeft: string;
    sendEmails: boolean;
}

@entity("Main", "Master")
class ThenConfig extends Entity {
    environment: string;
    email: ThenMailConfig;
}

/** A cache's promise: memoised by its producer, typed, and stamped with its value. */
function cached<T>(value: T, runtimeType: () => RuntimeType): Promise<T> {
    return markStable(Promise.resolve(value), runtimeType, { value });
}

function config(): ThenConfig {
    return ThenConfig.create({
        environment: "Test",
        email: ThenMailConfig.create({ urlLeft: "http://localhost:5173", sendEmails: false }),
    });
}

describe("thenTyped", () => {

    test("the derived promise is QUERY-READABLE, which a plain .then never is", async () => {
        const source = cached(config(), () => new ClassType(ThenConfig));

        assert.ok(!isQueryReadablePromise(source.then(c => c.email)), "a plain .then must not qualify");
        assert.ok(isQueryReadablePromise(source.thenTyped(c => c.email)));
    });

    test("the same member off the same source is the SAME promise — the stability .$v demands", () => {
        const source = cached(config(), () => new ClassType(ThenConfig));

        assert.equal(source.thenTyped(c => c.email), source.thenTyped(c => c.email));
        // …and a DIFFERENT member is a different promise, as it should be.
        assert.notEqual(source.thenTyped(c => c.email), source.thenTyped(c => c.environment));
    });

    test("the type is derived from the source's, without awaiting anything", () => {
        const source = cached(config(), () => new ClassType(ThenConfig));

        const email = source.thenTyped(c => c.email);
        const type = stableRuntimeType(email as never);
        assert.ok(type instanceof ClassType, String(type));
        assert.equal((type as ClassType).constructorFunction, ThenMailConfig);

        // A nested path walks every step.
        const urlLeft = source.thenTyped(c => c.email.urlLeft);
        assert.equal(stableRuntimeType(urlLeft as never), LiteralType.string);
    });

    test("an already-loaded source projects its value immediately, not a microtask later", () => {
        const source = cached(config(), () => new ClassType(ThenConfig));

        const email = source.thenTyped(c => c.email) as { resolvedValue?: { value: ThenMailConfig } };
        assert.equal(email.resolvedValue?.value.urlLeft, "http://localhost:5173");
    });

    test("it still behaves as a promise", async () => {
        const source = cached(config(), () => new ClassType(ThenConfig));
        assert.equal((await source.thenTyped(c => c.email)).urlLeft, "http://localhost:5173");
    });

    test("a ONE-OFF promise is refused — it could never converge", () => {
        assert.throws(() => Promise.resolve(config()).thenTyped(c => c.email), /STABLE promise/);
    });

    test("a selector that is not a plain member read is refused", () => {
        const source = cached(config(), () => new ClassType(ThenConfig));
        assert.throws(() => source.thenTyped(c => c.email.urlLeft + c.environment), /ONE member path/);
    });
});
