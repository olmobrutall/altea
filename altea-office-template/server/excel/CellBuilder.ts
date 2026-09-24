import { Temporal, Decimal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { Enum } from "@altea/altea/data/enum";
import { Lite } from "@altea/altea/data/lite";
import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/index";
import type { Column } from "@altea/altea/server/dynamicQuery/requests";
import { OxmlElement, OxmlText } from "../oxml/OxmlElement";

// Port of Signum.Excel's CellBuilder.cs — see port/OfficeTemplate.md.
//
// How ONE result value becomes one `<c>` cell: which of the template's cell formats styles it, and how the
// value is written (Excel stores a date as a number, a string either inline or in the shared pool, …).
//
// The style map is keyed off the TOKEN's `filterType` — the same discriminator the SearchControl editors
// and the importer use — plus the token's `type` for the enum object, which is what makes `PlainDate` /
// `PlainDateTime` / `PlainTime` distinct without extra probing.
//
// Values arrive as altea runtime types: a `Temporal.PlainDate(Time)`, a decimal.js `Decimal` (or, from
// some numeric columns, a RAW STRING — the projector does not always box it), a `Lite`. An ENUM value in
// memory is its ORDINAL, so the display name comes from `Enum.niceName(enumObject, ordinal)` and the
// import-round-trip name from `Enum.toName`. Multiline reads `FieldInfo.isMultiline`.

/** Which of the template's cell formats a value is written with. */
export enum DefaultStyle {
    Title,
    Header,
    Date,
    DateTime,
    Text,
    General,
    Boolean,
    Enum,
    Number,
    Decimal,
    Percentage,
    Time,
    Multiline,
}

/** The two cell shapes Excel has: text lives INSIDE the cell (`<is>`), everything else is a `<v>` value. */
function isInlineString(style: DefaultStyle): boolean {
    switch (style) {
        case DefaultStyle.Title:
        case DefaultStyle.Header:
        case DefaultStyle.Text:
        case DefaultStyle.General:
        case DefaultStyle.Enum:
        case DefaultStyle.Multiline:
            return true;
        default:
            return false;
    }
}

export class CellBuilder {
    /** DefaultStyle → the `s=` index of the template cell that carries that format. */
    defaultStyles = new Map<DefaultStyle, number>();
    /** `<cellXfs count>` of the template — where newly appended formats start. */
    cellFormatCount = 0;
    /** Number-format expression → the cell-format index minted for it. */
    customDecimalStyles = new Map<string, number>();

    styleIndex(style: DefaultStyle): number {
        const index = this.defaultStyles.get(style);
        if (index == undefined)
            throw new Error(`The plain Excel template has no cell for the '${DefaultStyle[style]}' style`);
        return index;
    }

    /** The style a value of this token's type gets by default. */
    getDefaultStyle(token: QueryToken): DefaultStyle {
        switch (token.filterType) {
            case "Integer": return DefaultStyle.Number;
            case "Decimal": return DefaultStyle.Decimal;
            case "Boolean": return DefaultStyle.Boolean;
            case "Enum": return DefaultStyle.Enum;
            case "DateTime": return token.type?.typeName === "PlainDate" ? DefaultStyle.Date : DefaultStyle.DateTime;
            case "Time": return DefaultStyle.Time;
            case "String": return DefaultStyle.Text;
            default: return DefaultStyle.General; // Lite / Embedded / Model / Guid
        }
    }

    /**
     * The style AND its cell-format index for one query column.
     *
     * A number column with a unit ("Kg") or a non-default format ("C2", "P") cannot use the template's
     * generic decimal format, so a cell format carrying its own number-format expression is minted on
     * demand; PlainExcelGenerator appends them to the stylesheet in the same order.
     */
    getDefaultStyleAndIndex(c: Column): { defaultStyle: DefaultStyle; styleIndex: number } {
        const token = c.token;
        const isNumber = token.filterType === "Integer" || token.filterType === "Decimal";

        if (isNumber && (hasText(c.unit) || (c.format != undefined && c.format !== defaultFormatOf(token)))) {
            const formatExpression = getCustomFormatExpression(c.unit, c.format);
            let styleIndex = this.customDecimalStyles.get(formatExpression);
            if (styleIndex == undefined) {
                styleIndex = this.cellFormatCount++;
                this.customDecimalStyles.set(formatExpression, styleIndex);
            }
            return {
                defaultStyle: token.filterType === "Integer" ? DefaultStyle.Number : DefaultStyle.Decimal,
                styleIndex,
            };
        }

        const defaultStyle =
            token.filterType === "String" && isMultiline(token) ? DefaultStyle.Multiline :
                token.filterType === "DateTime" && c.format === "d" ? DefaultStyle.Date :
                    token.filterType === "Decimal" && c.format?.toLowerCase() === "p" ? DefaultStyle.Percentage :
                        this.getDefaultStyle(token);

        return { defaultStyle, styleIndex: this.styleIndex(defaultStyle) };
    }

    /**
     * The `<c>` element for one value.
     *
     * `forImport` writes the value the IMPORTER can read back (an enum's member name, a lite's full key)
     * rather than the value a human reads (the localized enum name, the entity's ToString).
     */
    cell(value: unknown, style: DefaultStyle, styleIndex: number, forImport = false): OxmlElement {
        const excelValue = value == null ? "" : this.toExcelValue(value, style, forImport);

        const cell = new OxmlElement("c");
        cell.setAttribute("s", String(styleIndex));

        if (isInlineString(style)) {
            cell.setAttribute("t", "inlineStr");
            const is = cell.appendChild(new OxmlElement("is"));
            const t = is.appendChild(new OxmlElement("t"));
            if (excelValue !== excelValue.trim())
                t.space = "preserve";
            t.appendChild(new OxmlText(excelValue));
        } else {
            if (style === DefaultStyle.Boolean)
                cell.setAttribute("t", "b");
            const v = cell.appendChild(new OxmlElement("v"));
            v.appendChild(new OxmlText(excelValue));
        }

        return cell;
    }

    private toExcelValue(value: unknown, style: DefaultStyle, forImport: boolean): string {
        switch (style) {
            case DefaultStyle.Date:
            case DefaultStyle.DateTime:
                return toExcelDate(value);
            case DefaultStyle.Time:
                return toExcelTime(value);
            case DefaultStyle.Number:
            case DefaultStyle.Decimal:
            case DefaultStyle.Percentage:
                return toExcelNumber(value);
            case DefaultStyle.Boolean:
                return value === true || value === "true" ? "1" : "0";
            default:
                return toExcelText(value, forImport);
        }
    }
}

// ---- value conversions ----------------------------------------------------------------------------------

const OA_EPOCH = Temporal.PlainDate.from("1899-12-30"); // Excel's serial-date origin (an OLE Automation date)

/** A date as Excel's serial number (days since 1899-12-30, time as the fraction). */
export function toExcelDate(value: unknown): string {
    if (value instanceof Temporal.PlainDate)
        return String(value.since(OA_EPOCH).total("days"));

    if (value instanceof Temporal.PlainDateTime) {
        // Signum's `datetime.ToUserInterface().ToOADate()`: an Excel serial has no zone, so it is written
        // as the reader's wall time, not the clock's.
        const ui = Clock.toUserInterface(value);
        const days = ui.toPlainDate().since(OA_EPOCH).total("days");
        const fraction = ui.toPlainTime().since(Temporal.PlainTime.from("00:00")).total("days");
        return String(days + fraction);
    }

    // A raw string / Date from a driver that did not box the value.
    if (typeof value === "string")
        return toExcelDate(value.includes("T") || value.includes(" ")
            ? Temporal.PlainDateTime.from(value.replace(" ", "T"))
            : Temporal.PlainDate.from(value));

    throw new Error(`Unable to write ${String(value)} as an Excel date`);
}

/** A time as its fraction of a day. */
export function toExcelTime(value: unknown): string {
    if (value instanceof Temporal.PlainTime)
        return String(value.since(Temporal.PlainTime.from("00:00")).total("days"));
    if (typeof value === "string")
        return toExcelTime(Temporal.PlainTime.from(value));
    throw new Error(`Unable to write ${String(value)} as an Excel time`);
}

/** The invariant decimal representation (never the UI culture's). */
export function toExcelNumber(value: unknown): string {
    if (value instanceof Decimal)
        return value.toString();
    if (typeof value === "number")
        return String(value);
    if (typeof value === "boolean")
        return value ? "1" : "0";
    if (typeof value === "string" && value !== "")
        return new Decimal(value).toString();
    throw new Error(`Unable to write ${String(value)} as an Excel number`);
}

/** The text of a non-numeric value: an enum's name, a lite's ToString (or key, for a re-importable file). */
function toExcelText(value: unknown, forImport: boolean): string {
    if (value instanceof Lite)
        return forImport ? value.key() : (value.toString() || value.key());

    if (value instanceof Temporal.PlainDate || value instanceof Temporal.PlainDateTime || value instanceof Temporal.PlainTime)
        return value.toString();

    if (value instanceof Decimal)
        return value.toString();

    return String(value);
}

/** An ENUM value is an ordinal in memory: the display name is localized, the import name is the member. */
export function enumText(value: unknown, token: QueryToken, forImport: boolean): string {
    const enumObject = token.type?.getEnum?.();
    if (enumObject == undefined || value == null)
        return value == null ? "" : String(value);

    const ordinal = value as number;
    return forImport
        ? Enum.toName(enumObject as Record<string, string | number>, ordinal)
        : Enum.niceName(enumObject as Record<string, string | number>, ordinal);
}

// ---- number formats -------------------------------------------------------------------------------------

/** The unit becomes a currency prefix when Excel knows it, else a
 *  quoted suffix ("#,##0.00 \"Kg\""). */
export function getCustomFormatExpression(columnUnit: string | undefined, columnFormat: string | undefined): string {
    const prefix =
        columnUnit === "$" ? "[$$-409]" :
            columnUnit === "£" ? "[$£-809]" :
                columnUnit === "¥" ? "[$¥-804]" : "";

    const suffix = prefix === "" && hasText(columnUnit) ? `" ${columnUnit}"` : "";

    return prefix + getExcelFormat(columnFormat) + suffix;
}

/** A .NET numeric format string ("N2", "C", "P1", "D3") as an Excel format code. */
export function getExcelFormat(columnFormat: string | undefined): string {
    if (columnFormat == undefined)
        return "#,##0.00";

    const f = columnFormat.toUpperCase();
    const digits = (after: string, fallback: number): number => {
        const n = parseInt(after, 10);
        return isNaN(n) ? fallback : n;
    };
    const places = (n: number): string => n === 0 ? "" : "." + "0".repeat(n);

    switch (f[0]) {
        case "C": return "#,##0" + places(digits(f.slice(1), 2));
        case "N": return "#,##0" + places(digits(f.slice(1), 2));
        case "D": return "0".repeat(digits(f.slice(1), 1));
        case "F": return "0" + places(digits(f.slice(1), 2));
        case "E": return "0" + places(digits(f.slice(1), 2));
        case "P": return "0" + places(digits(f.slice(1), 2)) + "%";
        default: return columnFormat;
    }
}

/** The authored width of a column, by its type. */
export function getColumnWidth(token: QueryToken): number {
    switch (token.filterType) {
        case "DateTime": return token.type?.typeName === "PlainDate" ? 15 : 20;
        case "String": return 50;
        case "Lite": return 50;
        default: return 10;
    }
}

// ---- small helpers ---------------------------------------------------------------------------------------

function hasText(s: string | undefined | null): boolean {
    return s != undefined && s !== "";
}

/** The format a value of this type gets with no explicit `[Format]` — a custom cell format is only minted
 *  when the column's format DIFFERS from it. */
function defaultFormatOf(token: QueryToken): string | undefined {
    return token.filterType === "Decimal" ? "N2" : undefined;
}

/** The MultiLine flag is display metadata on the FieldInfo, where Signum reads it off the property's
 *  StringLengthValidator — it carries it
 *  directly as display metadata (set by @stringLengthValidator({ multiLine }) / @multiline). */
function isMultiline(token: QueryToken): boolean {
    return token.getPropertyRoute()?.fieldInfo?.isMultiline === true;
}
