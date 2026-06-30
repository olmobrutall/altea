
import type { ColumnOptions } from "../entities/reflection";

export { ColumnOptions };

// Schema layer barrel. The implementation lives under ./schema/.
export * from "./schema/dbType";
export * from "./schema/objectName";
export * from "./schema/column";
export * from "./schema/nameSequence";
export * from "./schema/field";
export * from "./schema/table";
export * from "./schema/schema";
export * from "./schema/schemaBuilder";

// The `@column` field decorator now lives in entities/ (the entity model owns its
// column annotations). Re-exported here for back-compat.
export { column } from "../entities/decorators";
