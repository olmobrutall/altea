import { withQuoted } from "./decorators";

// Signum's LinqHints.DistinctNull: whether two nullable values DIFFER, counting null as a value — so null and
// 3 differ and null and null do not. A plain `a != b` inside a query is SQL's `<>`, which is neither true
// nor false when either side is NULL; this spells the comparison out, so it answers the same in SQL as in
// memory (and as SQL's `IS DISTINCT FROM`).
export const distinctNull = withQuoted(function distinctNull<T>(a: T | null | undefined, b: T | null | undefined): boolean {
    return (a == null && b != null) || (a != null && (b == null || a != b));
});
