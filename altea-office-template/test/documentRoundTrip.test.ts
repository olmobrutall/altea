import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import "@altea/altea/data/globals";
import { Entity } from "@altea/altea/data/entity";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { ScopedDictionary } from "@altea/altea-templating/server/TemplateUtils";
import type { ValueProviderBase } from "@altea/altea-templating/server/ValueProviders";
import type { TemplateSynchronizationContext } from "@altea/altea-templating/server/TemplateSync";
import { OxmlPackage } from "@altea/altea-office-template/server/oxml/OxmlPackage";
import { OfficeTemplateParser } from "@altea/altea-office-template/server/OfficeTemplateParser";
import { BaseNode } from "@altea/altea-office-template/server/OfficeTemplateNodes";
import type { OfficeTemplateEntity } from "@altea/altea-office-template/data/OfficeTemplate";

// parse → `renderTemplate` must be FAITHFUL over a DOCUMENT, because that pair is what the token
// migration's document pass rests on: it parses the stored .docx, repairs the tokens in it, and writes
// the bytes back (see OfficeTemplateTokenSync). A `renderTemplate` that drops or reorders anything does
// not fail — it silently rewrites somebody's template.
//
// It is the office counterpart of @altea/altea-templating's `test/templateRoundTrip.test.ts`, and DB-free
// the same way: a token that fails to RESOLVE is a NON-FATAL parser error, so an unregistered query name
// yields a complete tree full of unresolved tokens — precisely the state a stale template is in.
//
// One thing the text half needs and this one does not: a self-check before writing back. A fatal text
// parse error ABORTS the parse and leaves a tree that is a PREFIX of the template. Here the nodes replace
// markers IN PLACE inside the real document, so there is no prefix state to write — and a marker that
// found no partner is still a MatchNode, which `assertClean` throws on.

/** Any entity stands in for a query name: nothing resolves against it, which is what we want. */
class FakeQuery extends Entity { }
const query = FakeQuery;

const WORD_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const OFFICE_DOCUMENT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** The smallest .docx `OxmlPackage.load` accepts: a content-type map, the package rels, one document. */
function docx(paragraphs: string[][]): Uint8Array {
    const body = paragraphs
        .map(runs => `<w:p>${runs.map(t => `<w:r><w:t xml:space="preserve">${escapeXml(t)}</w:t></w:r>`).join("")}</w:p>`)
        .join("");

    const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

    return zipSync({
        "[Content_Types].xml": utf8(
            `<?xml version="1.0" encoding="UTF-8"?>`
            + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
            + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
            + `<Override PartName="/word/document.xml" ContentType="${WORD_MAIN}"/>`
            + `</Types>`),
        "_rels/.rels": utf8(
            `<?xml version="1.0" encoding="UTF-8"?>`
            + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
            + `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT}" Target="word/document.xml"/>`
            + `</Relationships>`),
        "word/document.xml": utf8(
            `<?xml version="1.0" encoding="UTF-8"?>`
            + `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`),
    });
}

function escapeXml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The visible text of each paragraph, which is what a token round trip has to preserve. */
function paragraphTexts(package_: OxmlPackage): string[] {
    return package_.mainPart.document.root
        .descendantsNamed("w:p")
        .map(p => p.descendantsNamed("w:t").map(t => t.innerText).join(""));
}

/**
 * Parse the document, then print every node back as literal template text — the second half of the
 * document sync pass, run on its own.
 */
function reprint(paragraphs: string[][]): string[] {
    const package_ = OxmlPackage.load(docx(paragraphs));
    const parser = new OfficeTemplateParser(package_, {} as OfficeTemplateEntity, query, undefined);
    parser.parseDocument();
    parser.createNodes();
    parser.assertClean();

    for (const root of package_.allRootElements) {
        const variables = new ScopedDictionary<ValueProviderBase>(undefined);
        for (const node of root.descendantsOfType(BaseNode))
            node.renderTemplate(variables);
    }

    return paragraphTexts(package_);
}

describe("parse → renderTemplate round trip over a document", () => {

    // One case per construct, so a failure names the node that broke. Each entry is the paragraphs of a
    // document, one paragraph per line — the block keywords span paragraphs the way a real .docx does.
    const cases: [string, string[]][] = [
        ["a plain value", ["Dear @[Customer.Name],"]],
        ["a format", ["Shipped @[ShipDate:dd/MM/yyyy]"]],
        ["an explicit query prefix", ["@[q:Customer.Name]"]],
        ["a global", ["Printed @[g:Now]"]],
        ["a constant", ["@[42]"]],
        ["a declare", ["@declare[Customer.Name] as $c"]],
        ["a foreach", ["@foreach[Details] as $d", "@[$d.Product]", "@endforeach"]],
        ["an if", ["@if[TotalPrice>100]", "big", "@endif"]],
        ["an if/else", ["@if[TotalPrice>100]", "big", "@else", "small", "@endif"]],
        ["an if/elseif/else", ["@if[TotalPrice>100]", "big", "@elseif[TotalPrice>50]", "mid", "@else", "small", "@endif"]],
        ["an any/notany", ["@any[Details.Any.Product=X]", "some", "@notany", "none", "@endany"]],
        ["a condition with &&", ["@if[TotalPrice>100 && State=Shipped]", "both", "@endif"]],
        ["a condition with ||", ["@if[TotalPrice>100 || State=Shipped]", "both", "@endif"]],
        ["nesting", ["@foreach[Details] as $d", "@if[TotalPrice>1]", "@[$d.Product]", "@endif", "@endforeach"]],
        ["literals around everything", ["Hi @[Name]! Bye."]],
        ["no markers at all", ["Just some text.", "On two lines."]],
    ];

    for (const [what, paragraphs] of cases)
        test(what, () => assert.deepEqual(reprint(paragraphs.map(p => [p])), paragraphs));

    // THE reason this module needs a parser of its own: Word SHATTERS a token across runs — a spell-check
    // boundary, a language mark, one italic letter — so the marker exists only in the CONCATENATION.
    // Reassembly has to survive the print-back too, or the sync pass rewrites the template into garbage.
    test("a token shattered across runs comes back whole", () => {
        assert.deepEqual(
            reprint([["Dear @[Cust", "omer.N", "ame], hi"]]),
            ["Dear @[Customer.Name], hi"]);
    });

    test("two tokens in one paragraph, split mid-token", () => {
        assert.deepEqual(
            reprint([["@[A", ".B] and @[C.", "D]"]]),
            ["@[A.B] and @[C.D]"]);
    });

    // A marker with no partner is not silently dropped: it stays a MatchNode, and `assertClean` says so.
    // That is what stands in for the text half's write-back self-check.
    test("an unbalanced keyword is REFUSED, not half-applied", () => {
        assert.throws(() => reprint([["@foreach[Details] as $d"], ["@[$d.Product]"]]),
            /unexpected MatchNode/);
    });
});

// ---- the synchronize walk -------------------------------------------------------------------------

/**
 * A stand-in for TemplateSynchronizationContext that RECORDS what it was asked and resolves each token
 * the first time — which is what makes the driver's second visit of a nested node a no-op.
 */
function spyContext(): { sc: TemplateSynchronizationContext; asked: string[] } {
    const asked: string[] = [];
    const sc = {
        hasChanges: false,
        queryName: query,
        modelType: undefined,
        stringDistance: undefined,
        variables: new ScopedDictionary<ValueProviderBase>(undefined),
        tokenSync: { askRename: async (bucket: string, _s: unknown, old: string) => { asked.push(`${bucket}:${old}`); return old; } },
        newScope(): { dispose: () => void } {
            sc.variables = new ScopedDictionary<ValueProviderBase>(sc.variables);
            return { dispose: () => { sc.variables = sc.variables.previous!; } };
        },
        async synchronizeToken(parsedToken: { tokenString: string; queryToken: unknown }, remainingText: string): Promise<void> {
            if (parsedToken.queryToken != undefined)
                return;
            asked.push(`${remainingText} ${parsedToken.tokenString}`);
            parsedToken.queryToken = { fullKey: () => parsedToken.tokenString };
        },
        async getMembers(chain: string): Promise<undefined> { asked.push(`members ${chain}`); return undefined; },
    };
    return { sc: sc as unknown as TemplateSynchronizationContext, asked };
}

describe("the synchronize walk", () => {

    async function walk(paragraphs: string[]): Promise<string[]> {
        const package_ = OxmlPackage.load(docx(paragraphs.map(p => [p])));
        const parser = new OfficeTemplateParser(package_, {} as OfficeTemplateEntity, query, undefined);
        parser.parseDocument();
        parser.createNodes();
        parser.assertClean();

        const { sc, asked } = spyContext();
        for (const root of package_.allRootElements)
            for (const node of root.descendantsOfType(BaseNode))
                await node.synchronize(sc);

        return asked;
    }

    // Each construct is REACHED, in document order, and each token asked EXACTLY ONCE. Both halves are
    // load-bearing: the driver's own sweep stops at a block container (its body lives in a BlockNode that
    // is not its child in the tree), so a nested token is reached ONLY by the container recursing — and
    // reached once, not once per level.
    test("every construct is reached, in document order, and each token asked once", async () => {
        assert.deepEqual(await walk([
            "@declare[Customer.Name] as $c",
            "@foreach[Details] as $d",
            "@if[TotalPrice>100]",
            "@[$d.Product]",
            "@else",
            "@[g:Now]",
            "@endif",
            "@endforeach",
            "@[Customer.Name]",
        ]), [
            "@declare Customer.Name",
            "@foreach Details",
            "@if TotalPrice",
            "@ $d.Product",
            "Global:Now",   // a global is a rename in its OWN bucket, never a query token
            "@ Customer.Name",
        ]);
    });

    // `@any` and each `@elseif` carry a condition of their own, and each is asked separately.
    test("an any and an elseif each carry their own condition", async () => {
        assert.deepEqual(await walk([
            "@any[Details.Any.Product=X]", "a", "@notany", "b", "@endany",
            "@if[A>1]", "c", "@elseif[B>2]", "d", "@endif",
        ]), [
            "@any Details.Any.Product",
            "@if A",
            "@elseif B",
        ]);
    });
});
