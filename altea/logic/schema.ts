
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
    return function (_value: unknown, context: ClassFieldDecoratorContext | ClassAccessorDecoratorContext) {
        if (context.metadata == null)
            throw new Error("Decorator metadata is required but not available in this runtime");

        const key = String(context.name);
        const normalizedOptions: ColumnOptions = {
            ...options,
            columnName: options.columnName ?? key,
        };

        const typeInfo = getOrCreateTypeInfo(context.metadata);
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
