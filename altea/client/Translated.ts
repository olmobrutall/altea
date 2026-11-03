// Signum's `translated(entity, e => e.field)`: the current culture's text of a translatable field, which the
// server ships beside it as `<field>_translated` (see setTranslatedFieldProvider), else the stored value.
// Keyed by the field name rather than a lambda: altea has no expression parsing on the client.
export function translated<T extends object, K extends keyof T & string>(entity: T, field: K): T[K] {
    const value = (entity as Record<string, unknown>)[field + "_translated"];
    return (value ?? entity[field]) as T[K];
}
