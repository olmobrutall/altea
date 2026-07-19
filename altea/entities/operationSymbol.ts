import { reflect } from './reflection';
import { entity, EntityKind, EntityData } from './decorators';
import { Symbol } from './symbol';

// Port of Signum's OperationSymbol (Signum/Operations/Operation.cs): the single concrete
// Symbol entity that backs every operation (all operations are rows in this one table,
// like Signum). SystemString + Master, non-identity PK seeded by SymbolLogic.
// `@reflect @entity(...)` together mirrors TypeEntity (the other SystemString system
// table): @entity carries the kind/data, @reflect anchors the transformer's registerType
// import. Symbol containers reference this class as the value passed to init() (the
// transformer injects `import { OperationSymbol } from ".../operations"`, which re-exports
// it), so no self-registration is needed.
@reflect
@entity(EntityKind.SystemString, EntityData.Master)
export class OperationSymbol extends Symbol {
}
