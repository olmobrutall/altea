import type { Entity } from "../entities/entity";
import type { Lite } from "../entities/lite";
import type { OperationSymbol } from "../entities/operations";

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
