// Server-side extension methods on the entity model. The entity classes
// (entities/) stay server-agnostic; the methods that need the server — persisting
// a graph (`save`) or turning an entity/lite into a query (`inDB`, `retrieve`,
// `retrieveAndRemember`) — are declared and installed here, in one place.
//
// Importing this module installs the prototypes (side effect). The ported test
// suite pulls it in via MusicLoader; the type augmentations are ambient (the file
// is part of the @altea/altea program), so callers see the methods without importing.

import { Entity } from '../entities/entity';
import { Lite } from '../entities/lite';
import type { IQuery } from '../entities/iquery';
import { Saver } from './saver';

// Logic-layer barrel: re-exports the common server entry points alongside installing
// the entity/lite extension-method prototypes (below).
export { table, view } from './table';
// from ./schema/schemaBuilder (not the ./schema barrel) — `./schema` is ambiguous at
// runtime (a schema.ts file and a schema/ directory both exist; ESM resolves to the dir).
export { SchemaBuilder } from './schema/schemaBuilder';

declare module '../entities/entity' {
    interface Entity {
        // Saves this entity and its reachable graph in one transaction, returning the
        // entity so calls chain inline (Signum's `new XEntity { … }.Execute(Save)`).
        save(): Promise<this>;
        // Re-query this single in-memory entity against the database (Signum's InDB).
        // `inDB()` yields a one-row query; `inDB(selector)` projects it.
        inDB(): IQuery<this>;
        inDB<V>(selector: (entity: this) => V): V;
    }
}

declare module '../entities/lite' {
    interface Lite<out T extends Entity> {
        // Re-query the referenced entity (Signum's Lite.InDB).
        inDB(): IQuery<T>;
        inDB<V>(selector: (entity: T) => V): V;
        // Retrieve the referenced entity from the database.
        retrieve(): T;
        // Retrieve the referenced entity and cache it on the lite (Signum's RetrieveAndRemember).
        retrieveAndRemember(): T;
    }
}

Entity.prototype.save = async function (this: Entity): Promise<Entity> {
    await Saver.save([this]);
    return this;
};

(Entity.prototype as any).inDB = function (this: Entity): never {
    throw new Error("inDB (entity→query bridge) is not implemented yet");
};

(Lite.prototype as any).inDB = function (this: Lite<Entity>): never {
    throw new Error("inDB (lite→query bridge) is not implemented yet");
};

Lite.prototype.retrieve = function (this: Lite<Entity>): never {
    throw new Error("retrieve (lite→entity) is not implemented yet");
};

Lite.prototype.retrieveAndRemember = function (this: Lite<Entity>): never {
    throw new Error("retrieveAndRemember is not implemented yet");
};
