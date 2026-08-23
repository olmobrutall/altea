import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Lite } from "@altea/altea/data/lite";
import "@altea/altea/server/context.node";
import { Isolation, IsolationEntity, IsolationMixin } from "../../data/Isolation";
import { IsolationLogic } from "../../server/IsolationLogic.server";
import { CatalogEntity, ProjectEntity, TagEntity } from "../data/tenancy";

// The ambient current-isolation and the strategy table, with NO database: they are pure in-memory logic, and
// they are where the port diverges most from Signum (a scope-shaped ambient instead of an IDisposable), so
// they are worth pinning on their own.

// A lite without a database: the isolation rows do not exist, but nothing here reads them.
function isolationLite(id: number, name: string): Lite<IsolationEntity> {
    return IsolationEntity.newLite(id, name);
}

describe("the ambient current isolation", () => {

    test("is null outside any scope — Signum's 'no override', i.e. global mode", () => {
        assert.equal(IsolationLogic.current(), null);
    });

    test("unsafeOverride establishes one for its scope, and only for its scope", () => {
        const acme = isolationLite(1, "Acme");
        IsolationLogic.unsafeOverride(acme, () => {
            assert.equal(IsolationLogic.current()?.toString(), "Acme");
        });
        assert.equal(IsolationLogic.current(), null);
    });

    test("unsafeOverride REPLACES an established one — that is what makes it unsafe", () => {
        IsolationLogic.unsafeOverride(isolationLite(1, "Acme"), () => {
            IsolationLogic.unsafeOverride(isolationLite(2, "Globex"), () => {
                assert.equal(IsolationLogic.current()?.toString(), "Globex");
            });
            assert.equal(IsolationLogic.current()?.toString(), "Acme");
        });
    });

    test("disable runs in global mode inside an established isolation", () => {
        IsolationLogic.unsafeOverride(isolationLite(1, "Acme"), () => {
            IsolationLogic.disable(() => assert.equal(IsolationLogic.current(), null));
            assert.equal(IsolationLogic.current()?.toString(), "Acme");
        });
    });

    test("override ADOPTS when nothing is current", () => {
        IsolationLogic.override(isolationLite(1, "Acme"), () => {
            assert.equal(IsolationLogic.current()?.toString(), "Acme");
        });
    });

    test("override with null is a no-op — nothing to adopt", () => {
        let ran = false;
        IsolationLogic.override(null, () => { ran = true; assert.equal(IsolationLogic.current(), null); });
        assert.ok(ran);
    });

    test("override with the SAME isolation is allowed", () => {
        IsolationLogic.unsafeOverride(isolationLite(1, "Acme"), () => {
            IsolationLogic.override(isolationLite(1, "Acme"), () => {
                assert.equal(IsolationLogic.current()?.toString(), "Acme");
            });
        });
    });

    test("override THROWS when it would CHANGE an established isolation", () => {
        IsolationLogic.unsafeOverride(isolationLite(1, "Acme"), () => {
            assert.throws(() => IsolationLogic.override(isolationLite(2, "Globex"), () => undefined),
                /Trying to change isolation from Acme to Globex/);
        });
    });

    test("the scope holds across an await — it is async-local, not a global", async () => {
        const acme = isolationLite(1, "Acme");
        await IsolationLogic.unsafeOverride(acme, async () => {
            await new Promise(r => setTimeout(r, 1));
            assert.equal(IsolationLogic.current()?.toString(), "Acme");
        });
        assert.equal(IsolationLogic.current(), null);
    });

    test("two concurrent scopes do not see each other", async () => {
        const seen: string[] = [];
        await Promise.all([
            IsolationLogic.unsafeOverride(isolationLite(1, "Acme"), async () => {
                await new Promise(r => setTimeout(r, 5));
                seen.push(`A:${IsolationLogic.current()?.toString()}`);
            }),
            IsolationLogic.unsafeOverride(isolationLite(2, "Globex"), async () => {
                await new Promise(r => setTimeout(r, 1));
                seen.push(`B:${IsolationLogic.current()?.toString()}`);
            }),
        ]);
        assert.deepEqual(seen.sort(), ["A:Acme", "B:Globex"]);
    });
});

describe("the strategy table", () => {

    test("register is idempotent for the same strategy and throws on a conflicting one", () => {
        Isolation.register(ProjectEntity, "Isolated");
        Isolation.register(ProjectEntity, "Isolated"); // again: fine, an app's overrides may run twice
        assert.throws(() => Isolation.register(ProjectEntity, "None"),
            /already registered as Isolated, cannot change it to None/);
    });

    test("strategy throws for an unregistered type; tryStrategy answers None", () => {
        class UnregisteredEntity { }
        assert.throws(() => Isolation.strategy(UnregisteredEntity), /No isolation strategy registered/);
        assert.equal(Isolation.tryStrategy(UnregisteredEntity), "None");
    });

    test("Isolated and Optional declare the mixin; None does not", () => {
        Isolation.register(TagEntity, "Optional");
        Isolation.register(CatalogEntity, "None");

        // The field exists on the owner (altea flattens a mixin onto it), which is what lets the client
        // deserialize it — and the reason the strategy table is declared in the DATA layer.
        assert.doesNotThrow(() => new ProjectEntity().mixin(IsolationMixin as never));
        assert.doesNotThrow(() => new TagEntity().mixin(IsolationMixin as never));
        assert.throws(() => new CatalogEntity().mixin(IsolationMixin as never), /is not declared on 'CatalogEntity'/);
    });

    test("tryIsolation is safe on a NOT-isolated entity", () => {
        assert.equal(Isolation.tryIsolation(new CatalogEntity()), null);
    });

    test("setIsolation / tryIsolation round-trip on an isolated entity", () => {
        const acme = isolationLite(1, "Acme");
        const p = Isolation.setIsolation(new ProjectEntity(), acme);
        assert.equal(Isolation.tryIsolation(p)?.toString(), "Acme");
    });

    test("whereCurrentIsolationInMemory keeps un-isolated rows and drops foreign ones", () => {
        const acme = isolationLite(1, "Acme");
        const mine = Isolation.setIsolation(new ProjectEntity(), acme);
        const theirs = Isolation.setIsolation(new ProjectEntity(), isolationLite(2, "Globex"));
        const global = new CatalogEntity();

        IsolationLogic.unsafeOverride(acme, () => {
            const kept = IsolationLogic.whereCurrentIsolationInMemory([mine, theirs, global] as never[]);
            assert.deepEqual(kept, [mine, global]);
        });

        // With no isolation current, nothing is filtered at all.
        assert.equal(IsolationLogic.whereCurrentIsolationInMemory([mine, theirs, global] as never[]).length, 3);
    });
});

