import type { Quoted, QuotedEx, ExProperty, ExArray, ExAs } from "quote-transformer/quoted";

// Extracts the entity field names an index selector reads, from its QUOTED AST — the altea
// analogue of Signum's Engine/Schema/TableIndexes.cs IndexKeyColumns.Split over a KeySelector
// expression tree. A single field (`e => e.code`), an array of fields (`e => [e.a, e.b]`), or a
// path through EMBEDDED values (`e => e.address.city`, which flattens to the one column
// `address_city`) — returned dotted, for Table.columnsFromFields to walk. A path through a
// REFERENCE is not indexable here (it is a column on the other table), and `accessedFields` cannot
// tell the two apart from the AST alone, so the resolution — and the error — belong to the table.
//
// Replaces the earlier approach of running the selector against a recording Proxy: it reads the
// captured lambda instead of executing it, so it is isomorphic (no live entity needed) and shares
// the same `@quoted` machinery the filtered-index predicate (getIndexWhere) already uses.
export function accessedFields(selector: Quoted<(element: any) => unknown>): string[] {
    const quoted = selector.__quoted;
    if (quoted == null)
        throw new Error("An index selector must be @quoted (e => e.code or e => [e.a, e.b]). Is ts-patch + quote-transformer configured?");

    const body = quoted()[2]; // ExLambda = ["=>", params, body]
    const elements = body[0] === "[]" ? (body as ExArray)[1] : [body];
    const fields = elements.map(memberName);
    if (fields.length === 0)
        throw new Error("An index selector must read at least one field, e.g. e => [e.name] or e => e.code");
    return fields;
}

// One member PATH read off the selector parameter → its dotted name ("code", "address.city").
function memberName(e: QuotedEx): string {
    // A cast (`e.code as string`) and a non-null assertion (`e.address!.city`) are runtime no-ops —
    // unwrap them, like the index-where visitor.
    if (e[0] === "as")
        return memberName((e as ExAs)[1]);
    if (e[0] === "!")
        return memberName((e as unknown as [string, QuotedEx])[1]);

    if (e[0] === "." || e[0] === "?.") {
        const prop = e as ExProperty;
        // Rooted at the parameter → the leaf name. Rooted at another access → keep walking, and join
        // with a dot (an EMBEDDED step; Table.columnsFromFields resolves it, and rejects a reference).
        if (prop[1][0] === "p")
            return prop[2];
        return memberName(prop[1]) + "." + prop[2];
    }

    throw new Error(`An index selector must read fields off its parameter (e => e.code, e => [e.a, e.b] or e => e.embedded.field); got ${JSON.stringify(e)}`);
}
