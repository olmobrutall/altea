import { setDatabaseSchema } from './reflection';
import { entity } from './decorators';
import { Symbol } from './symbol';

// Port of Signum's OperationSymbol (Signum/Operations/Operation.cs): the single concrete
// Symbol entity that backs every operation (all operations are rows in this one table,
// like Signum). SystemString + Master, non-identity PK seeded by SymbolLogic.
// `@entity(...)` alone carries the kind/data AND the registration, as TypeEntity (the other
// SystemString system table) declares it. Symbol containers reference this class as the value passed to init() (the
// transformer injects `import { OperationSymbol } from ".../operations"`, which re-exports
// it), so no self-registration is needed.
@entity("SystemString", "Master")
export class OperationSymbol extends Symbol {
}

// Signum declares this in the `Signum.Operations` namespace, which the core assembly maps to the
// `operations` SCHEMA — so a Signum database has `operations.operation`, not `basics.operation`. altea
// keeps the whole core model in one data/ folder (declared `basics`), so the schema is named per type.
// OperationLogEntity carries the same override; see setDatabaseSchema.
setDatabaseSchema("operations", OperationSymbol);
