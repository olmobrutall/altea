import type { Entity } from "../data/entity";
import type { ExecuteSymbol, DeleteSymbol } from "../data/operations";
import { FluentInclude } from "./schema/fluentInclude";
import { Graph } from "./graph";
import "./index"; // installs Entity.delete() (the default withDelete body)

// Port of Signum's `FluentOperationInclude` (Operations/OperationLogic.cs) — the `WithSave` /
// `WithDelete` extension methods on FluentInclude<T>. Kept in the operations layer (not the schema
// layer) so schema stays independent of operations; added by declaration merging + prototype
// augmentation, exactly like DynamicQueryFluentInclude.withQuery (dynamicQuery/fluentIncludeQuery.ts).
// Importing this module installs the methods (side effect).
declare module "./schema/fluentInclude" {
    interface FluentInclude<T extends Entity> {
        // Signum's `WithSave(saveOperation, execute?)`: a plain Save Execute (CanBeNew + CanBeModified),
        // whose body defaults to a no-op — the operation's implicit save persists the entity. Pass an
        // `execute` to run extra logic on save (e.g. Southwind's EmployeeOperation.Save regenerating
        // passages). Registers the operation and returns the FluentInclude for chaining.
        withSave(saveOperation: ExecuteSymbol<T>, execute?: (entity: T, args: unknown[]) => void | Promise<void>): this;
        // Signum's `WithDelete(deleteOperation, delete?)`: a Delete op whose body defaults to
        // `entity.delete()` (the set-based single-row delete installed by server/index.ts).
        withDelete(deleteOperation: DeleteSymbol<T>, del?: (entity: T, args: unknown[]) => void | Promise<void>): this;
    }
}

FluentInclude.prototype.withSave = function <T extends Entity>(this: FluentInclude<T>, saveOperation: ExecuteSymbol<T>, execute?: (entity: T, args: unknown[]) => void | Promise<void>): FluentInclude<T> {
    new Graph.Execute<T>(this.type, saveOperation, {
        canBeNew: true,
        canBeModified: true,
        execute: execute ?? (() => { }),
    }).register();
    return this;
};

FluentInclude.prototype.withDelete = function <T extends Entity>(this: FluentInclude<T>, deleteOperation: DeleteSymbol<T>, del?: (entity: T, args: unknown[]) => void | Promise<void>): FluentInclude<T> {
    new Graph.Delete<T>(this.type, deleteOperation, {
        delete: del ?? (e => e.delete()),
    }).register();
    return this;
};
