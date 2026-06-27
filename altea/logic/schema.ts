
import { getOrCreateFieldInfo, getOrCreateTypeInfo } from "../entities/reflection";
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

// Field-level decorator: overrides column mapping (name / db types / size /
// precision / nullability) for a field. Stored on FieldInfo.columnOptions and
// consumed by SchemaBuilder.
export function column(options: ColumnOptions = {}) {
    return function (target: object, propertyKey: string | symbol) {
        const key = String(propertyKey);
        const normalizedOptions: ColumnOptions = {
            ...options,
            columnName: options.columnName ?? key,
        };

        const typeInfo = getOrCreateTypeInfo(target);
        const existing = getOrCreateFieldInfo(typeInfo, key);
        existing.columnOptions = normalizedOptions;
        // Mirror an explicit nullable into the field's nullability so the column
        // is generated NULL even when the TS type isn't `| null` (Signum's
        // ForceNullable). Auto-@field never sets nullable for a non-null type, so
        // this is the authoritative source for those.
        if (options.nullable != null)
            existing.isNullable = options.nullable;
        typeInfo.fields[key] = existing;
    };
}
