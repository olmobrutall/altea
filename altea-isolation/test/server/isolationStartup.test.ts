import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/server/context.node";
import "@altea/altea/server/operationFluentInclude";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import "@altea/altea/server";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { reflect } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { entity, quoted, stringLengthValidator } from "@altea/altea/data/decorators";
import { OperationLogic } from "@altea/altea/server/operationLogic";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { Isolation, IsolationEntity, IsolationOperation } from "../../data/Isolation";
import { IsolationLogic } from "../../server/IsolationLogic.server";
import { CatalogEntity, ProjectEntity, TagEntity } from "../data/tenancy";

// `assertIsolationStrategies` is the module's safety net, and it needs NO database: it compares the built
// schema's table list against the declared strategies, in memory, on `schemaCompleted`. It is worth its own
// file because the failure it prevents — a type quietly falling through as un-isolated, so its rows are
// visible from every tenant — is the worst thing this module could get wrong.
//
// Each case builds its own SchemaBuilder, since the whole point is what a DIFFERENT set of includes does.
// The strategy table is process-global (as Signum's is), so the cases that must see an UNDECLARED type use
// a locally declared entity class rather than un-registering a fixture one.

@reflect
@entity("String", "Master")
class UndeclaredEntity extends Entity {
    @stringLengthValidator({ min: 1, max: 100 }) name: string;
    @quoted toString(): string { return this.name; }
}

@reflect
@entity("String", "Master")
class ReferencedEntity extends Entity {
    @stringLengthValidator({ min: 1, max: 100 }) name: string;
    @quoted toString(): string { return this.name; }
}

@reflect
@entity("String", "Master")
class ReferrerEntity extends Entity {
    @stringLengthValidator({ min: 1, max: 100 }) name: string;
    target: Lite<ReferencedEntity> | null;
    @quoted toString(): string { return this.name; }
}

/** Declared a strategy but never included — the "Remove something like" half of the message. */
@reflect
@entity("String", "Master")
class NotIncludedEntity extends Entity {
    @stringLengthValidator({ min: 1, max: 100 }) name: string;
    @quoted toString(): string { return this.name; }
}

describe("assertIsolationStrategies", () => {

    // The types each case decides about itself; everything else the schema contains is framework
    // bookkeeping (TypeEntity, the operation log, …), which a real app also has to declare — Signum exempts
    // only enum and symbol tables. Declaring them "None" here is exactly what an app would do, and it keeps
    // each case's message about ITS types.
    const caseOwned: Function[] = [ProjectEntity, TagEntity, CatalogEntity,
        UndeclaredEntity, ReferencedEntity, ReferrerEntity, NotIncludedEntity];

    // Returns the COMPLETION step, because that is where the assertion runs: `sb.complete()` fires
    // `schemaCompleted`, exactly as a real host's startup does.
    function completionOf(include: (sb: SchemaBuilder) => void): () => void {
        // The operation registry is process-global (Signum's is too), so a second `IsolationLogic.start`
        // would fail on `withSave`. Each case builds a fresh schema on purpose, so drop the registration.
        OperationLogic.unregister(IsolationOperation.Save);

        const sb = new SchemaBuilder();
        sb.settings.isPostgres = true;
        IsolationLogic.start(sb);
        include(sb);

        // TypeEntity is added by `complete()` itself, so it is not in the map yet.
        Isolation.register(TypeEntity, "None");
        for (const tab of sb.schema.tables.values()) {
            const ctor = tab.type as Function;
            // IsolationEntity is EXEMPT, so declaring it would be the "Remove something like" half.
            if (!caseOwned.includes(ctor) && ctor !== (IsolationEntity as unknown as Function))
                Isolation.register(ctor as never, "None");
        }

        return () => sb.complete();
    }

    test("passes when every table has declared a strategy", () => {
        Isolation.register(ProjectEntity, "Isolated");
        Isolation.register(TagEntity, "Optional");
        Isolation.register(CatalogEntity, "None");

        const complete = completionOf(b => {
            b.include(ProjectEntity).withQuery();
            b.include(TagEntity).withQuery();
            b.include(CatalogEntity).withQuery();
        });

        assert.doesNotThrow(complete);
    });

    test("throws — with a copy-pasteable line — for a table that declared nothing", () => {
        // A type this file alone knows about, so no other case can have registered it.
        const complete = completionOf(b => {
            b.include(ProjectEntity).withQuery();
            b.include(TagEntity).withQuery();
            b.include(CatalogEntity).withQuery();
            b.include(UndeclaredEntity).withQuery();
        });

        assert.throws(complete, (e: Error) => {
            assert.match(e.message, /strategies are not synchronized with the Schema/);
            assert.match(e.message, /Add something like:/);
            assert.match(e.message, /Isolation\.register\(UndeclaredEntity, "XXX"\);/);
            return true;
        });
    });

    test("the failure names WHO REFERENCES the undeclared type, which is what decides its strategy", () => {
        const complete = completionOf(b => {
            b.include(ProjectEntity).withQuery();
            b.include(TagEntity).withQuery();
            b.include(CatalogEntity).withQuery();
            b.include(ReferencedEntity).withQuery();
            b.include(ReferrerEntity).withQuery();
        });

        assert.throws(complete, (e: Error) => {
            assert.match(e.message, /Isolation\.register\(ReferencedEntity, "XXX"\); \/\/ referenced by: ReferrerEntity.target/);
            return true;
        });
    });

    test("an ENUM or SYMBOL table is exempt — its rows are declared, not application data", () => {
        // The schema always contains TypeEntity + the operation/permission symbol tables; the passing case
        // above proves they do not have to be registered.
        const complete = completionOf(b => {
            b.include(ProjectEntity).withQuery();
            b.include(TagEntity).withQuery();
            b.include(CatalogEntity).withQuery();
        });
        assert.doesNotThrow(complete);
    });

    test("throws for a strategy declared on something that is not a table at all", () => {
        Isolation.register(NotIncludedEntity, "Isolated");

        const complete = completionOf(b => {
            b.include(ProjectEntity).withQuery();
            b.include(TagEntity).withQuery();
            b.include(CatalogEntity).withQuery();
        });

        assert.throws(complete, (e: Error) => {
            assert.match(e.message, /Remove something like:/);
            assert.match(e.message, /Isolation\.register\(NotIncludedEntity, "XXX"\);/);
            return true;
        });
    });
});
