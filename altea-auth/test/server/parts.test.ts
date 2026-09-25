import { describe, test, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import type { PrimaryKey, Type, Entity } from "@altea/altea/data/entity";
import type { RoleEntity } from "@altea/altea-auth/data/Role";
import { TypeAuthLogic } from "@altea/altea-auth/server/TypeAuthLogic";
import { partRoots, type PartEdge } from "@altea/altea-auth/server/PartOwnership";
import { TypeAllowedBasic } from "@altea/altea-auth/data/Rules";
import { SampleEntity, SamplePanelEntity, SampleWidgetEntity } from "../data/sample";
import { start, hasDb, role, asRole, Roles } from "./setup";

// Part-ownership redesign: a Part inherits its ROOT owner's auth (never its own rule) and is hidden from
// the Type-Auth grid. partRoots is the pure core (edge list → part→root, forbidding multi-owner); the
// DB-gated block verifies the wiring: Panel/Widget are excluded and inherit Sample (Widget through the
// Panel → Sample chain).

describe("PartOwnership.partRoots (pure)", () => {
    const C = (name: string): Type<Entity> => { const f = function (): void { /* stub ctor */ }; Object.defineProperty(f, "name", { value: name }); return f as unknown as Type<Entity>; };

    test("chains to the nearest non-Part root (Widget → Panel → Sample)", () => {
        const Sample = C("Sample"), Panel = C("Panel"), Widget = C("Widget");
        const roots = partRoots([{ owner: Sample, part: Panel }, { owner: Panel, part: Widget }]);
        assert.equal(roots.get(Panel), Sample);
        assert.equal(roots.get(Widget), Sample);
    });

    test("polymorphic content: every impl owned by the panel roots to the panel's root", () => {
        const Dash = C("Dash"), Panel = C("Panel"), Chart = C("Chart"), Text = C("Text");
        // Dash ← Panel[] → content: IPart (@implementedBy [Chart, Text]) — the Dashboard shape.
        const edges: PartEdge[] = [{ owner: Dash, part: Panel }, { owner: Panel, part: Chart }, { owner: Panel, part: Text }];
        const roots = partRoots(edges);
        assert.equal(roots.get(Chart), Dash);
        assert.equal(roots.get(Text), Dash);
    });

    test("multi-owner Part is FORBIDDEN (use SharedPart)", () => {
        const A = C("A"), B = C("B"), Shared = C("Shared");
        assert.throws(() => partRoots([{ owner: A, part: Shared }, { owner: B, part: Shared }]), /owners/);
    });
});

describe.skipIf(hasDb ? false : "set ALTEA_AUTH_TEST_DB (and run gen) to enable")("Part auth inheritance", () => {
    let sales: RoleEntity, base: RoleEntity;
    let sampleId: PrimaryKey, panelId: PrimaryKey, widgetId: PrimaryKey;

    beforeAll(async () => {
        await start();
        [sales, base] = await Promise.all([role(Roles.Sales), role(Roles.Base)]);
        const caches = await TypeLogic.caches();
        sampleId = caches.typeToId(SampleEntity);
        panelId = caches.typeToId(SamplePanelEntity);
        widgetId = caches.typeToId(SampleWidgetEntity);
    });

    test("Parts (and enums) are excluded from the Type-Auth grid; Sample stays", async () => {
        const pack = await TypeAuthLogic.getTypeRulePack(sales.id);
        const names = pack.rules.map(r => r.resource.toString());
        assert.ok(names.includes("Sample"), "the owner Sample is present");
        assert.ok(!names.includes("SamplePanel"), "Part SamplePanel is hidden");
        assert.ok(!names.includes("SampleWidget"), "Part SampleWidget is hidden");
        assert.ok(!names.some(n => n.startsWith("EnumEntity")), "enum side-tables are hidden");
    });

    test("Panel inherits Sample (Sales: Read yes / Write no; Base: nothing)", async () => {
        const salesKey = sales.toLite().key(), baseKey = base.toLite().key();
        assert.equal(await TypeAuthLogic.isAllowedForType(panelId, TypeAllowedBasic.Read, true, salesKey), true);
        assert.equal(await TypeAuthLogic.isAllowedForType(panelId, TypeAllowedBasic.Write, true, salesKey), false);
        assert.equal(await TypeAuthLogic.isAllowedForType(panelId, TypeAllowedBasic.Read, true, baseKey), false);
    });

    test("Widget inherits Sample through the Panel → Sample chain", async () => {
        const salesKey = sales.toLite().key(), baseKey = base.toLite().key();
        assert.equal(await TypeAuthLogic.isAllowedForType(widgetId, TypeAllowedBasic.Read, true, salesKey), true);
        assert.equal(await TypeAuthLogic.isAllowedForType(widgetId, TypeAllowedBasic.Read, true, baseKey), false);
    });
});

// A Part queried DIRECTLY (`table(Part)`) is row-gated by its ROOT's TypeCondition, rebased onto the Part
// via its back-reference chain (panel.sample / widget.panel.sample). Via-owner access is NOT affected (the
// owner's collection projection bypasses the query-filter marker) — this is the isolated-part path only.
describe.skipIf(hasDb ? false : "set ALTEA_AUTH_TEST_DB (and run gen) to enable")("Standalone-part row filter", () => {
    let restricted: RoleEntity, superRole: RoleEntity;

    beforeAll(async () => {
        await start();
        [restricted, superRole] = await Promise.all([role(Roles.Restricted), role(Roles.Super)]);
    });

    test("Super sees every part (root reduces to 'all' → no filter)", async () => {
        await asRole(superRole, async () => {
            assert.equal((await table(SamplePanelEntity).toArray()).length, 2);
            assert.equal((await table(SampleWidgetEntity).toArray()).length, 2);
        });
    });

    test("Restricted sees only the public sample's part (root [Public] condition rebased onto the part)", async () => {
        await asRole(restricted, async () => {
            const panels = await table(SamplePanelEntity).toArray() as SamplePanelEntity[];
            assert.equal(panels.length, 1);
            assert.equal(panels[0].title, "P-pub");
            // The chain reaches through Panel → Sample.
            const widgets = await table(SampleWidgetEntity).toArray() as SampleWidgetEntity[];
            assert.equal(widgets.length, 1);
            assert.equal(widgets[0].caption, "W-pub");
        });
    });
});
