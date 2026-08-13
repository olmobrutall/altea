import type { Schema } from "@altea/altea/server/schema";
import type { TypeCaches } from "@altea/altea/server/typeLogic";
import type { PrimaryKey } from "@altea/altea/data/entity";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { cleanTypeName } from "@altea/altea/data/registration";

// TEST-ONLY. Installs a DETERMINISTIC type↔id cache into a schema that has no database to load from, so
// an OFFLINE SQL-comparison binder can emit a stable @implementedByAll discriminator constant. This is the
// ONLY place ids are "invented": production TypeLogic loads the real DB-assigned ids (and throws if asked
// before that load). The numbering mirrors generation's insert order — function-typed entity ctors sorted
// by name, 1..N — so for an unchanged schema these equal the ids the DB would assign; but since offline
// tests never execute, only determinism matters. Kept out of the framework on purpose: inventing ids is a
// test concern, not an engine one.
export function seedTypeCachesForTest(schema: Schema): void {
    const ctors: Function[] = [];
    for (const [type] of schema.tables)
        if (typeof type === "function")
            ctors.push(type as Function);
    ctors.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const typeToId = new Map<Function, PrimaryKey>();
    const idToType = new Map<PrimaryKey, Function>();
    const idToEntity = new Map<PrimaryKey, TypeEntity>();

    ctors.forEach((ctor, i) => {
        const id: PrimaryKey = i + 1;
        const te = new TypeEntity();
        (te as { id: PrimaryKey }).id = id;
        te.isNew = false;
        te.className = ctor.name;
        te.cleanName = cleanTypeName(ctor);
        te.tableName = schema.tryTable(ctor as never)!.name.name;
        te.package = "";
        typeToId.set(ctor, id);
        idToType.set(id, ctor);
        idToEntity.set(id, te);
    });

    schema.typeCaches.preset({ typeToId, idToType, idToEntity } satisfies TypeCaches);
}
