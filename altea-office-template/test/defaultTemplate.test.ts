import "@altea/altea/server/context.node";
import { test, describe, afterEach } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { toInt } from "@altea/altea/data/basics";
import { LiteImp } from "@altea/altea/data/lite";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { CultureInfoEntity, setCultureNameResolver } from "@altea/altea/data/cultureInfoEntity";
import type { ResetLazy } from "@altea/altea/server/resetLazy";
import { OfficeModelEntity, OfficeTemplateEntity } from "@altea/altea-office-template/data/OfficeTemplate";
import { OfficeTemplateLogic } from "@altea/altea-office-template/server/OfficeTemplateLogic";

// Signum's WordModelLogic.GetDefaultTemplate: a model renders with its applicable template in the report's
// culture, else the parent culture, else its only template. Offline: the template cache is a literal map.

const cultures: Record<number, string> = { 1: "en", 2: "de", 3: "de-DE" };
setCultureNameResolver(lite => cultures[lite.id as number]);

const model = OfficeModelEntity.create({ className: "AgreementWordModel" });
model.id = toInt(10); model.isNew = false;
const otherModel = OfficeModelEntity.create({ className: "OtherWordModel" });
otherModel.id = toInt(11); otherModel.isNew = false;

let nextId = 100;
function template(name: string, cultureId: number, of = model): OfficeTemplateEntity {
    const t = OfficeTemplateEntity.create({ name, model: of, applicable: null });
    t.culture = new LiteImp(toInt(cultureId), CultureInfoEntity, cultures[cultureId]);
    t.id = toInt(nextId++); t.isNew = false;
    return t;
}

function useTemplates(...templates: OfficeTemplateEntity[]): void {
    const map = new Map(templates.map(t => [String(t.id), t]));
    OfficeTemplateLogic.officeTemplatesLazy = { value: async () => map, reset: () => { } } as unknown as ResetLazy<Map<string, OfficeTemplateEntity>>;
}

const defaultUICulture = CultureInfo.defaultUICulture();
afterEach(() => CultureInfo.setDefaultUICulture(defaultUICulture));

describe("OfficeTemplateLogic.getDefaultTemplate", () => {

    test("the template in the current culture wins", async () => {
        useTemplates(template("English", 1), template("Deutsch", 3), template("Other", 3, otherModel));
        CultureInfo.setDefaultUICulture("de-DE");
        assert.equal((await OfficeTemplateLogic.getDefaultTemplate(model, null)).name, "Deutsch");
    });

    test("else the parent culture's", async () => {
        useTemplates(template("English", 1), template("Deutsch", 2));
        CultureInfo.setDefaultUICulture("de-DE");
        assert.equal((await OfficeTemplateLogic.getDefaultTemplate(model, null)).name, "Deutsch");
    });

    test("else the model's only template, whatever its culture", async () => {
        useTemplates(template("English", 1));
        CultureInfo.setDefaultUICulture("de-DE");
        assert.equal((await OfficeTemplateLogic.getDefaultTemplate(model, null)).name, "English");
    });

    test("several candidates and none in the culture is an error", async () => {
        useTemplates(template("English", 1), template("English too", 1));
        CultureInfo.setDefaultUICulture("de-DE");
        await assert.rejects(() => OfficeTemplateLogic.getDefaultTemplate(model, null), /More than one active OfficeTemplate/);
    });
});
