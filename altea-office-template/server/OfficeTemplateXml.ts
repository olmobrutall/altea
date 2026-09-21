import { table } from "@altea/altea/server/table";
import { Enum } from "@altea/altea/data/enum";
import { toInt } from "@altea/altea/data/basics";
import {
    FilterOperation, FilterGroupOperation, OrderType, DashboardBehaviour,
} from "@altea/altea/data/dynamicQueries";
import { UserAssetsImporter, syncRows, rowGuid } from "@altea/altea-user-assets/server/UserAssetsImportExport";
import type { IToXmlContext, IFromXmlContext } from "@altea/altea-user-assets/server/UserAssetsImportExport";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import { CultureInfoLogic } from "@altea/altea/server/cultureInfoLogic";
import { cultureNameOf } from "@altea/altea/data/cultureInfoEntity";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { TemplateApplicableEval } from "@altea/altea-templating/data/Templating";
import { FileEntity } from "@altea/altea-files/data/Files";
import {
    OfficeConverterSymbol, OfficeTemplateEntity, OfficeTemplateEntity_Filter, OfficeTemplateEntity_Order,
    OfficeTransformerSymbol,
} from "../data/OfficeTemplate";
import { OfficeModelLogic } from "./OfficeModelLogic";

// Port of Signum.Word's `WordTemplateEntity.ToXml/FromXml` — see port/OfficeTemplate.md.
//
// It stays OFF the isomorphic entity
// (System.Xml is server-only) and registers a (de)serializer with UserAssetsImporter — the shape
// @altea/altea-user-queries' UserQueriesXml established and @altea/altea-email's EmailTemplateXml followed.
// The XML element / attribute names are preserved so a Signum-produced file round-trips, apart from the
// module-wide Word→Office rename.
//
// altea divergences, documented inline:
//  - The root element is `OfficeTemplate` (Signum: `WordTemplate`), and the two symbol attributes are
//    `OfficeTransformer` / `OfficeConverter` — the rename this package is named for.
//  - `Guid` → the asset's uuid PRIMARY KEY (the importer keys on it).
//  - `Culture` carries the plain locale string (altea has no CultureInfoEntity).
//  - `Applicable` was a C# SCRIPT element in Signum; the TemplateApplicableSymbol's KEY is exported
//    instead. A file carrying a script imports with the predicate left unset — the template then applies
//    to everything, which is the safe reading (the same call EmailTemplateXml made).
//  - `Template` is a `Lite<FileEntity>` Signum resolves through the export SET; the bytes are written
//    base64 INSIDE the element instead — which is what Signum's FileEntity element holds anyway, so a
//    file round-trips.
//  - An enum attribute keeps the member NAME (`Enum.toName`); the in-memory value is the ORDINAL.

const A = "@_"; // fast-xml-parser attribute prefix

export function registerOfficeTemplateXml(): void {
    UserAssetsImporter.register<OfficeTemplateEntity>({
        elementName: "OfficeTemplate",
        create: () => new OfficeTemplateEntity(),
        load: async guid => (await table(OfficeTemplateEntity).filter(t => t.id == guid).toArray() as OfficeTemplateEntity[])[0],
        save: async t => { await t.save(); },
        toXml: templateToXml,
        fromXml: templateFromXml,
    });
}

function templateToXml(ot: OfficeTemplateEntity, _ctx: IToXmlContext): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    o[A + "Name"] = ot.name;
    o[A + "DisableAuthorization"] = ot.disableAuthorization;
    if (ot.query != null) o[A + "Query"] = ot.query.key;
    if (ot.model != null) o[A + "Model"] = ot.model.className;
    o[A + "Culture"] = cultureNameOf(ot.culture);
    o[A + "FileName"] = ot.fileName;
    if (ot.officeTransformer != null) o[A + "OfficeTransformer"] = ot.officeTransformer.key;
    if (ot.officeConverter != null) o[A + "OfficeConverter"] = ot.officeConverter.key;
    o[A + "GroupResults"] = ot.groupResults;

    if (ot.filters.length) o["Filters"] = { Filter: ot.filters.map(filterXml) };
    if (ot.orders.length) o["Orders"] = { Orden: ot.orders.map(orderXml) };

    if (ot.applicable != null) o["Applicable"] = { "#cdata": ot.applicable.script };

    // The template document itself.
    if (ot.template != null) o["Template"] = {
        [A + "FileName"]: ot.template.fileName,
        "#text": base64Of(ot.template.binaryFile),
    };

    return o;
}

async function templateFromXml(ot: OfficeTemplateEntity, xml: Record<string, unknown>, ctx: IFromXmlContext): Promise<void> {
    ot.name = str(xml[A + "Name"])!;
    ot.disableAuthorization = bool(xml[A + "DisableAuthorization"]) ?? false;
    ot.query = xml[A + "Query"] != undefined ? ctx.getQuery(str(xml[A + "Query"])!) : null;
    ot.culture = (await CultureInfoLogic.getCulture(str(xml[A + "Culture"]) ?? CultureInfo.defaultUICulture())).toLite();
    ot.fileName = str(xml[A + "FileName"])!;
    ot.groupResults = bool(xml[A + "GroupResults"]) ?? false;

    // A model is only resolvable when the importing database registered it; an unknown one leaves the
    // template query-driven rather than failing the whole import (Signum throws — see the note below).
    ot.model = null;
    const modelName = str(xml[A + "Model"]);
    if (modelName != undefined) {
        try {
            ot.model = await OfficeModelLogic.getOfficeModelEntity(modelName);
        } catch {
            /* not registered in this database — left unset, so the template stays query-driven */
        }
    }

    ot.officeTransformer = symbolOr(OfficeTransformerSymbol, str(xml[A + "OfficeTransformer"]));
    ot.officeConverter = symbolOr(OfficeConverterSymbol, str(xml[A + "OfficeConverter"]));

    ot.filters = syncRows(ot.filters ?? [], list(asRecord(xml["Filters"])?.["Filter"]),
        () => new OfficeTemplateEntity_Filter(), (f, x, i) => {
            f.rowOrder = toInt(i);
            f.indentation = toInt(num(x[A + "Indentation"]) ?? 0);
            if (x[A + "GroupOperation"] != undefined) {
                f.isGroup = true;
                f.groupOperation = Enum.toValue(FilterGroupOperation, str(x[A + "GroupOperation"]) as never);
            }
            if (x[A + "Token"] != undefined) f.token = token(str(x[A + "Token"])!);
            if (x[A + "Operation"] != undefined) f.operation = Enum.toValue(FilterOperation, str(x[A + "Operation"]) as never);
            if (x[A + "Value"] != undefined) f.valueString = str(x[A + "Value"])!;
            // A `DashboardBehaviour` attribute is IGNORED: a template's filters drive no dashboard, so the
            // row has no such member (see QueryFilterPinnedBaseEntity). A file written by an application
            // that shared one filter type with its user queries may still carry it.
        });

    ot.orders = list(asRecord(xml["Orders"])?.["Orden"]).map((x, i) => {
        const o = new OfficeTemplateEntity_Order();
        o.rowOrder = toInt(i);
        o.token = token(str(x[A + "Token"])!);
        o.orderType = Enum.toValue(OrderType, str(x[A + "OrderType"]) as never);
        return o;
    });

    // `<Applicable><![CDATA[script]]></Applicable>`, round-tripped VERBATIM. A file written by
    // SIGNUM carries C#, which will not compile here — but it imports, and the error lands on the script
    // field where the author can see and fix it, which beats silently dropping the rule.
    const applicableScript = str(xml["Applicable"]);
    ot.applicable = applicableScript == undefined ? null
        : TemplateApplicableEval.create({ script: applicableScript });

    const template = asRecord(xml["Template"]);
    if (template != undefined) {
        ot.template = FileEntity.create({
            fileName: str(template[A + "FileName"]) ?? "template.docx",
            binaryFile: bytesOf(str(template["#text"]) ?? ""),
        });
    }
}

// ---- helpers -------------------------------------------------------------------------------------------

function filterXml(f: OfficeTemplateEntity_Filter): Record<string, unknown> {
    const x: Record<string, unknown> = { ...rowGuid(f) };
    x[A + "Indentation"] = f.indentation;
    if (f.isGroup) {
        if (f.groupOperation != null) x[A + "GroupOperation"] = Enum.toName(FilterGroupOperation, f.groupOperation);
        if (f.token != null) x[A + "Token"] = f.token.tokenString;
    } else {
        if (f.token != null) x[A + "Token"] = f.token.tokenString;
        if (f.operation != null) x[A + "Operation"] = Enum.toName(FilterOperation, f.operation);
        if (f.valueString != null) x[A + "Value"] = f.valueString;
    }
    return x;
}

function orderXml(o: OfficeTemplateEntity_Order): Record<string, unknown> {
    return { [A + "Token"]: o.token.tokenString, [A + "OrderType"]: Enum.toName(OrderType, o.orderType) };
}

function token(tokenString: string): QueryTokenEmbedded {
    return QueryTokenEmbedded.create({ tokenString });
}

/**
 * A symbol referenced by KEY. An unknown key leaves the field unset rather than failing the import: a
 * transformer / converter / applicable predicate is CODE-registered, so a file may legitimately name one
 * this database does not have, and the template is still usable without it.
 */
function symbolOr<T extends { key: string }>(ctor: new () => T, key: string | undefined): T | null {
    if (key == undefined)
        return null;
    const symbol = new ctor();
    (symbol as { key: string }).key = key;
    return symbol;
}

function base64Of(bytes: Uint8Array | null | undefined): string {
    return bytes == null ? "" : Buffer.from(bytes).toString("base64");
}

function bytesOf(base64: string): Uint8Array {
    return new Uint8Array(Buffer.from(base64, "base64"));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value != null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function list(value: unknown): Record<string, unknown>[] {
    if (value == null) return [];
    const array = Array.isArray(value) ? value : [value];
    return array.map(v => typeof v === "object" && v != null ? v as Record<string, unknown> : { "#text": v });
}

function str(value: unknown): string | undefined {
    return value == null ? undefined : String(value);
}

function num(value: unknown): number | undefined {
    return value == null ? undefined : Number(value);
}

function bool(value: unknown): boolean | undefined {
    return value == null ? undefined : value === true || value === "true" || value === "True";
}
