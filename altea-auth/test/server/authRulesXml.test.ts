import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { section, attrs, attr } from "@altea/altea-auth/server/AuthRulesXml";

// The AuthRules.xml export must be DIFFABLE: each role's rows come out sorted by their resource string, as
// Signum's `orderby resource` does, not in table order (where a rule re-saved in the editor moves to the end).

type Row = { onType: string; resource: string };
const rows: Row[] = [
    { onType: "Order", resource: "shipName" },
    { onType: "CultureInfo", resource: "englishName" },
    { onType: "Category", resource: "description" },
];
const byRole = new Map([["R", rows]]);
const names = (s: { Role: Record<string, unknown>[] }): string[] =>
    (s.Role[0]!["Property"] as Record<string, unknown>[]).map(e => attr(e, "OnType") + "|" + attr(e, "Resource"));

describe("AuthRules.xml section order", () => {
    test("rows are sorted by the section's resource string", () => {
        const s = section("Property", ["R"], k => k, byRole, r => attrs({ OnType: r.onType, Resource: r.resource }),
            e => attr(e, "OnType") + "|" + attr(e, "Resource"));
        assert.deepEqual(names(s), ["Category|description", "CultureInfo|englishName", "Order|shipName"]);
    });

    test("the default key is Resource", () => {
        const s = section("Property", ["R"], k => k, byRole, r => attrs({ OnType: r.onType, Resource: r.resource }));
        assert.deepEqual(names(s), ["Category|description", "CultureInfo|englishName", "Order|shipName"]);
    });
});
