import { describe, test, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import type { Lite } from "@altea/altea/data/lite";
import { TypeConditionLogic } from "@altea/altea-auth/server/TypeConditionLogic";
import { TypeAuthLogic } from "@altea/altea-auth/server/TypeAuthLogic";
import { TypeAllowedBasic } from "@altea/altea-auth/data/Rules";
import { SampleEntity, SampleLogEntity, SampleLogTypeCondition } from "../data/sample";
import { start, hasDb, asRole, role, Roles } from "./setup";

// The QUERY-AUDITOR type condition — `registerWhenAlreadyFilteringBy`, which Signum.DiffLog uses for
// `OperationLogTypeCondition.FilteringByTarget`.
//
// The rule under test: the `AuthTest_LogReader` role has SampleLog fallback None with one condition rule,
// `[FilteringByTarget] → Read`. That condition is not a property of the log ROW — it is a property of the
// QUERY: it holds when the caller has already pinned the log's `target` to something the role may read.
// So the same table answers with different rows depending on how it was asked, which is the whole point.
//
// The role's view of the TARGETS comes from the Restricted role it inherits: Sample is None with
// `[Public] → Read`, so PublicSample is readable and ConfidentialSample is not.
describe.skipIf(hasDb ? false : "set ALTEA_AUTH_TEST_DB (and run gen) to enable")("query-auditor type conditions (registerWhenAlreadyFilteringBy)", () => {

    beforeAll(() => start());

    async function targets(): Promise<{ pub: Lite<SampleEntity>; conf: Lite<SampleEntity> }> {
        const rows = await table(SampleEntity).filter(s => s.name == "PublicSample" || s.name == "ConfidentialSample").toArray() as SampleEntity[];
        return {
            pub: rows.find(r => r.name === "PublicSample")!.toLite(),
            conf: rows.find(r => r.name === "ConfidentialSample")!.toLite(),
        };
    }

    async function logId(action: string): Promise<number> {
        const log = await table(SampleLogEntity).filter(l => l.action == action).single() as SampleLogEntity;
        return log.id as number;
    }

    test("an unconstrained query sees NOTHING: the condition is about the query, and this one says nothing", async () => {
        const r = await role(Roles.LogReader);
        const rows = await asRole(r, () => table(SampleLogEntity).toArray()) as SampleLogEntity[];
        assert.equal(rows.length, 0, "no filter pins a target, so the condition does not hold for any row");
    });

    test("pinning the target to a READABLE row opens exactly that row", async () => {
        const { pub } = await targets();
        const r = await role(Roles.LogReader);
        const rows = await asRole(r, () => table(SampleLogEntity).filter(l => l.target!.is(pub)).toArray()) as SampleLogEntity[];
        assert.deepEqual(rows.map(l => l.action), ["log-public"]);
    });

    test("pinning the target to an UNREADABLE row still sees nothing", async () => {
        const { conf } = await targets();
        const r = await role(Roles.LogReader);
        const rows = await asRole(r, () => table(SampleLogEntity).filter(l => l.target!.is(conf)).toArray()) as SampleLogEntity[];
        assert.equal(rows.length, 0, "the caller pinned a target the role may not read");
    });

    // The caller pinned the log's own id, so the audit reads that row's target from
    // the database (ungated) and asks whether THAT is readable.
    test("pinning the row's id reads the target from the database", async () => {
        const r = await role(Roles.LogReader);
        const pubId = await logId("log-public");
        const confId = await logId("log-confidential");

        const allowed = await asRole(r, () => table(SampleLogEntity).filter(l => l.id == pubId).toArray()) as SampleLogEntity[];
        assert.deepEqual(allowed.map(l => l.action), ["log-public"]);

        const denied = await asRole(r, () => table(SampleLogEntity).filter(l => l.id == confId).toArray()) as SampleLogEntity[];
        assert.equal(denied.length, 0, "the id names a log whose target is not readable");
    });

    // The caller pinned the ROW itself (a lite), so the target comes from that row.
    test("pinning the row itself reads the target from it", async () => {
        const r = await role(Roles.LogReader);
        const pub = await table(SampleLogEntity).filter(l => l.action == "log-public").single() as SampleLogEntity;
        const conf = await table(SampleLogEntity).filter(l => l.action == "log-confidential").single() as SampleLogEntity;
        const pubLite = pub.toLite(), confLite = conf.toLite();

        const allowed = await asRole(r, () => table(SampleLogEntity).filter(l => l.is(pubLite)).toArray()) as SampleLogEntity[];
        assert.deepEqual(allowed.map(l => l.action), ["log-public"]);

        const denied = await asRole(r, () => table(SampleLogEntity).filter(l => l.is(confLite)).toArray()) as SampleLogEntity[];
        assert.equal(denied.length, 0);
    });

    // The auditor splits a conjunction (ConditionSplitter.SplitAnds), so a pinning filter still counts when
    // it is ANDed with unrelated ones — and a filter on something ELSE never counts.
    test("the pin is found inside a conjunction, and an unrelated filter is not mistaken for one", async () => {
        const { pub } = await targets();
        const r = await role(Roles.LogReader);

        const anded = await asRole(r, () =>
            table(SampleLogEntity).filter(l => l.action != "" && l.target!.is(pub)).toArray()) as SampleLogEntity[];
        assert.deepEqual(anded.map(l => l.action), ["log-public"], "the pin is one conjunct of two");

        const unrelated = await asRole(r, () =>
            table(SampleLogEntity).filter(l => l.action == "log-public").toArray()) as SampleLogEntity[];
        assert.equal(unrelated.length, 0, "filtering by action pins no target");
    });

    // A role WITHOUT the condition rule is unaffected: Super has no explicit SampleLog rule and is
    // default-allowed, so it reads every log row however it asks.
    test("a role that does not use the condition reads the table normally", async () => {
        const r = await role(Roles.Super);
        const rows = await asRole(r, () => table(SampleLogEntity).toArray()) as SampleLogEntity[];
        assert.equal(rows.length, 2);
    });

    // The per-INSTANCE half: `isAllowedFor` has an entity and no query, so the
    // condition is answered from the row's own target — filled by fillTypeConditions and cached, which is
    // what keeps the synchronous `inTypeCondition` able to answer for an auditor condition at all.
    test("the per-instance path answers from the row's own target", async () => {
        const r = await role(Roles.LogReader);
        const pub = await table(SampleLogEntity).filter(l => l.action == "log-public").single() as SampleLogEntity;
        const conf = await table(SampleLogEntity).filter(l => l.action == "log-confidential").single() as SampleLogEntity;

        await asRole(r, async () => {
            await TypeConditionLogic.fillTypeConditions([pub, conf]);
            assert.equal(TypeConditionLogic.inTypeCondition(pub, SampleLogTypeCondition.FilteringByTarget), true);
            assert.equal(TypeConditionLogic.inTypeCondition(conf, SampleLogTypeCondition.FilteringByTarget), false);

            assert.equal(await TypeAuthLogic.isAllowedFor(pub, TypeAllowedBasic.Read, true), true);
            assert.equal(await TypeAuthLogic.isAllowedFor(conf, TypeAllowedBasic.Read, true), false);
        });
    });

    // An auditor condition has no predicate of its own, so asking for one is a programming error rather
    // than a silently wrong query.
    test("asking for the SQL predicate of an auditor condition throws", () => {
        assert.equal(TypeConditionLogic.isQueryAuditor(SampleLogEntity, SampleLogTypeCondition.FilteringByTarget), true);
        assert.throws(
            () => TypeConditionLogic.getCondition(SampleLogEntity, SampleLogTypeCondition.FilteringByTarget),
            /query auditor/);
    });
});
