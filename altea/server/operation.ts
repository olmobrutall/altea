import type { Entity } from "../data/entity";
import type { Lite } from "../data/lite";
import type { OperationSymbol } from "../data/operations";

// Port of Signum's operation-kind enum + the IOperation interface family (Internal.cs /
// OperationLogic.cs), trimmed to what altea supports. The invoke methods are `doX` (not
// `x`) so they don't clash with the Graph.* classes' user-supplied `execute`/`delete`/
// `construct` FIELDS. Implemented by the Graph.* classes (graph.ts); consumed by
// OperationLogic (operationLogic.ts).

export enum OperationType {
    Execute = "Execute",
    Delete = "Delete",
    Constructor = "Constructor",
    ConstructorFrom = "ConstructorFrom",
    ConstructorFromMany = "ConstructorFromMany",
}

export interface IOperation {
    readonly operationSymbol: OperationSymbol;
    readonly operationType: OperationType;
    /**
     * The entity type this operation is REGISTERED ON (Signum's `IOperation.OverridenType`): the type
     * whose frame shows its button, and the key it is shipped under in the reflection metadata blob.
     * For a ConstructFrom / ConstructFromMany this is the SOURCE type, not the constructed one.
     * Explicit rather than derived, because a generic parameter is erased at runtime — see graph.ts.
     */
    readonly entityType: Function;
    assertIsValid(): void;
}

export interface IEntityOperation extends IOperation {
    canBeNew: boolean;
    canBeModified: boolean;
    onCanExecute(entity: Entity): string | null;
}

export interface IConstructOperation extends IOperation {
    doConstruct(args: unknown[]): Promise<Entity>;
}

export interface IConstructorFromOperation extends IEntityOperation {
    resultIsSaved: boolean;
    doConstructFrom(entity: Entity, args: unknown[]): Promise<Entity>;
}

export interface IConstructorFromManyOperation extends IOperation {
    doConstructFromMany(lites: Lite<Entity>[], args: unknown[]): Promise<Entity>;
}

export interface IExecuteOperation extends IEntityOperation {
    doExecute(entity: Entity, args: unknown[]): Promise<Entity>;
}

export interface IDeleteOperation extends IEntityOperation {
    doDelete(entity: Entity, args: unknown[]): Promise<void>;
}
