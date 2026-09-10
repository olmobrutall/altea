import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { Entity } from "@altea/altea/data/entity";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { TextTemplateParser } from "@altea/altea-templating/server/TextTemplateParser";
import { ScopedDictionary } from "@altea/altea-templating/server/TemplateUtils";
import type { ValueProviderBase } from "@altea/altea-templating/server/ValueProviders";
import type { TemplateSynchronizationContext } from "@altea/altea-templating/server/TemplateSync";

// parse → `write` must be FAITHFUL, because that pair is what the token-migration body pass rests on: it
// parses STORED template text, repairs the tokens in it, and writes it back (see TemplateSync). A `write`
// that drops or reorders anything does not fail — it silently rewrites somebody's template.
//
// DB-free, and the way it gets there is the point: a token that fails to RESOLVE is a NON-FATAL parse
// error, so an unregistered query name yields a complete tree full of unresolved tokens — which is
// precisely the state a stale template is in, and the state this pass exists to repair.

/** Any entity stands in for a query name here: nothing resolves against it, which is what we want. */
class FakeQuery extends Entity { }
const query = FakeQuery;

/** The re-print path `TextTemplateParser.synchronize` uses. */
function reprint(text: string): string {
    const { node } = TextTemplateParser.tryParse(text, query, undefined);
    const sb: string[] = [];
    node.write(sb, new ScopedDictionary<ValueProviderBase>(undefined));
    return sb.join("");
}

describe("parse → write round trip", () => {

    // One case per construct, so a failure names the node that broke.
    const cases: [string, string][] = [
        ["a plain value", "Dear @[Customer.Name],"],
        ["a raw value", "Total: @raw[TotalPrice]"],
        ["a format", "Shipped @[ShipDate:dd/MM/yyyy]"],
        ["an explicit query prefix", "@[q:Customer.Name]"],
        ["a global", "Printed @[g:Now]"],
        ["a constant", "@[42]"],
        ["a declare", "@declare[Customer.Name] as $c"],
        ["a foreach", "@foreach[Details] as $d@[$d.Product]@endforeach"],
        ["an if", "@if[TotalPrice>100]big@endif"],
        ["an if/else", "@if[TotalPrice>100]big@elsesmall@endif"],
        ["an if/elseif/else", "@if[TotalPrice>100]big@elseif[TotalPrice>50]mid@elsesmall@endif"],
        ["an any/notany", "@any[Details.Any.Product=X]some@notanynone@endany"],
        ["a condition with &&", "@if[TotalPrice>100 && State=Shipped]both@endif"],
        ["a condition with ||", "@if[TotalPrice>100 || State=Shipped]either@endif"],
        ["nesting", "@foreach[Details] as $d@if[TotalPrice>1]@[Product]@endif@endforeach"],
        ["literals around everything", "Hi @[Name]! Bye."],
        ["no markers at all", "Just some text.\nOn two lines."],
    ];

    for (const [what, text] of cases)
        test(what, () => assert.equal(reprint(text), text));
});

describe("synchronize", () => {

    /** Enough of a context for a walk that finds nothing to fix. */
    const quietContext = (): TemplateSynchronizationContext => ({
        hasChanges: false,
        queryName: query,
        modelType: undefined,
        template: { constructor: FakeQuery, toString: () => "a template" },
        // A rename that answers "unchanged" for whatever it is asked.
        tokenSync: { askRename: async (_b: unknown, _s: unknown, old: string) => old },
    } as unknown as TemplateSynchronizationContext);

    // The guard that a CLEAN template is never re-saved: with nothing rewritten the ORIGINAL string comes
    // back, which is what the callers compare on before writing to the database.
    test("returns the very same string when nothing changed", async () => {
        const text = "Printed @[g:Now], and a constant @[42].";
        const result = await TextTemplateParser.synchronize(text, quietContext());

        assert.equal(result, text);
        assert.ok(result === text, "the ORIGINAL string, not an equal copy");
    });

    test("an empty or absent body is returned as it came", async () => {
        const sc = quietContext();

        assert.equal(await TextTemplateParser.synchronize("", sc), "");
        assert.equal(await TextTemplateParser.synchronize(null, sc), null);
        assert.equal(await TextTemplateParser.synchronize(undefined, sc), undefined);
    });

    // THE safety net. A body with tokens and NO query is a FATAL parse error, which aborts the parse and
    // leaves a tree that is a PREFIX of the template — so the self-check refuses rather than writing that
    // truncation back. Without it this call would answer "Hi " for a template that reads "Hi @[Name]! Bye."
    test("a body that does not parse back to itself is left UNCHANGED", async () => {
        const text = "Hi @[Name]! Bye.";
        const sc = quietContext();
        (sc as { queryName: QueryName | undefined }).queryName = undefined; // no query → fatal

        assert.equal(await TextTemplateParser.synchronize(text, sc), text);
    });
});
