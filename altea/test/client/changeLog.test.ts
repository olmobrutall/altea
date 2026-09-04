import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/data/globals"; // Array.extract / .clear / .orderBy
import { mergeChangeLogs, type ChangeLogDic, type ChangeItem } from "@altea/altea/client/Basics/changeLogMerge";

// `mergeChangeLogs` — the body of Signum's `ChangeLogClient.getChangeLogs`, and the one non-trivial part
// of the change log.
//
// The problem it solves: a MODULE dates its entries by when they were IMPLEMENTED, which is not when the
// application carrying them was deployed. So the app's changelog carries `Update <Module>` lines, and each
// is REPLACED by that module's entries, which inherit the app's deploy date — the date a user actually saw
// the change. Everything a line did not claim belongs to the newest deployment.
//
// Worth pinning because none of it is visible from a type: the entries are plain dictionaries, and getting
// the merge wrong shows up as a change silently attributed to the wrong deployment, or dropped entirely.

/** The merged timeline as "deployDate module implDate: line" rows, for readable assertions. */
function rows(items: ChangeItem[]): string[] {
    return items.flatMap(i => i.changeLog.map(l => `${i.deployDate} ${i.module} ${i.implDate}: ${l}`));
}

function merge(mainLog: ChangeLogDic, modules: { [module: string]: ChangeLogDic } = {}): string[] {
    return rows(mergeChangeLogs(
        mainLog,
        Object.entries(modules).map(([module, dic]) => ({ module, dic })),
        "TheApp"));
}

describe("change log merge", () => {

    test("the app's own entries keep their own date as the deploy date, oldest first", () => {
        assert.deepEqual(merge({
            "2026-01-10": "second",
            "2026-01-05": ["first", "also first"],
        }), [
            "2026-01-05 TheApp 2026-01-05: first",
            "2026-01-05 TheApp 2026-01-05: also first",
            "2026-01-10 TheApp 2026-01-10: second",
        ]);
    });

    test("`Update <Module>` is CONSUMED and replaced by that module's earlier entries", () => {
        assert.deepEqual(
            merge({ "2026-02-01": ["ship it", "Update Altea"] },
                { Altea: { "2026-01-20": "a framework fix" } }),
            [
                "2026-02-01 TheApp 2026-02-01: ship it",
                // Implemented in January, DEPLOYED in February — and the "Update Altea" line itself is gone.
                "2026-02-01 Altea 2026-01-20: a framework fix",
            ]);
    });

    test("`Update <Module> to <date>` claims what predates THAT date, and stamps it with that date", () => {
        const result = merge({
            "2026-03-01": "Update Altea to 2026-02-01",
            "2026-04-01": "later release",
        }, {
            Altea: { "2026-01-15": "early", "2026-03-15": "late" },
        });

        // "early" predates the named date, so the line claims it — and Signum stamps it with the NAMED
        // date (2026-02-01), not with the deployment that carried it (2026-03-01). The named form says
        // "we took the module as of then"; only the bare `Update <Module>` form uses the deploy date.
        assert.ok(result.includes("2026-02-01 Altea 2026-01-15: early"), result.join(" | "));
        // "late" does not predate it, so it falls to the newest deployment rather than being dropped.
        assert.ok(result.includes("2026-04-01 Altea 2026-03-15: late"), result.join(" | "));
    });

    test("a module name covers its SUB-modules, so one line pulls in a whole family", () => {
        const result = merge({ "2026-05-01": "Update Altea" }, {
            "Altea": { "2026-04-01": "core" },
            "Altea.Chart": { "2026-04-02": "chart" },
            "Unrelated": { "2026-04-03": "other" },
        });

        assert.ok(result.includes("2026-05-01 Altea 2026-04-01: core"), result.join(" | "));
        assert.ok(result.includes("2026-05-01 Altea.Chart 2026-04-02: chart"), result.join(" | "));
        // A module NO line claimed is still shown — under the newest deployment — rather than lost.
        assert.ok(result.includes("2026-05-01 Unrelated 2026-04-03: other"), result.join(" | "));
    });

    test("a module with no matching Update line still reaches the newest deployment", () => {
        const result = merge({ "2026-06-01": "a", "2026-07-01": "b" },
            { Altea: { "2026-01-01": "orphan" } });

        assert.ok(result.includes("2026-07-01 Altea 2026-01-01: orphan"), result.join(" | "));
    });

    test("with no app changelog nothing is shown, module entries included", () => {
        // Signum's shape: the merge is driven by the APP's deployments, so with none there is no timeline
        // for a module entry to attach to.
        assert.deepEqual(merge({}, { Altea: { "2026-01-01": "unreachable" } }), []);
    });

    test("one line or an array of lines are both accepted", () => {
        assert.deepEqual(merge({ "2026-08-01": "single", "2026-08-02": ["one", "two"] }), [
            "2026-08-01 TheApp 2026-08-01: single",
            "2026-08-02 TheApp 2026-08-02: one",
            "2026-08-02 TheApp 2026-08-02: two",
        ]);
    });

    test("an entry a line claimed is not ALSO shown under the newest deployment", () => {
        const result = merge({ "2026-09-01": "Update Altea", "2026-09-10": "newest" },
            { Altea: { "2026-08-01": "once" } });

        assert.equal(result.filter(r => r.endsWith("once")).length, 1, result.join(" | "));
    });
});
