// Number formatting + numeric-type helpers for the Lines value editors. Ported from
// Signum.React/Reflection.ts (they are formatting, not reflection, so they live on their own here).
// Divergence: Signum reads a configurable NumberFormatSettings locale; altea defaults to the browser
// locale (undefined) until a settings layer lands.

// The altea numeric value TYPE name (the coarse TypeReference.typeName). Only "Number" occurs — the
// int/long/decimal split lives in `subTypeName` (see numberLimits). Kept as a set for symmetry.
const numberTypeNames = new Set(["Number"]);
export function isNumberType(name: string): boolean {
  return numberTypeNames.has(name);
}

export function toNumberFormat(format: string | undefined, locale?: string): Intl.NumberFormat {
  let loc = locale;
  if (loc?.startsWith("es-")) {
    loc = "de-DE"; //fix problem for Intl formatting "es" numbers for 4 digits over decimal point
  }
  return new Intl.NumberFormat(loc, toNumberFormatOptions(format));
}

export function toNumberFormatOptions(format: string | undefined): Intl.NumberFormatOptions | undefined {

  if (format == undefined)
    return undefined;

  const f = format.toUpperCase();

  function parseIntDefault(str: string, defaultValue: number) {
    var result = parseInt(str);
    if (isNaN(result))
      return defaultValue;

    return result;
  }

  if (f.startsWith("C")) //unit comes separated
    return { style: "decimal", minimumFractionDigits: parseIntDefault(f.after("C"), 2), maximumFractionDigits: parseIntDefault(f.after("C"), 2), useGrouping: true };

  if (f.startsWith("N"))
    return { style: "decimal", minimumFractionDigits: parseIntDefault(f.after("N"), 2), maximumFractionDigits: parseIntDefault(f.after("N"), 2), useGrouping: true };

  if (f.startsWith("D"))
    return { style: "decimal", maximumFractionDigits: 0, minimumIntegerDigits: parseIntDefault(f.after("D"), 1), useGrouping: false };

  if (f.startsWith("F"))
    return { style: "decimal", minimumFractionDigits: parseIntDefault(f.after("F"), 2), maximumFractionDigits: parseIntDefault(f.after("F"), 2), useGrouping: false };

  if (f.startsWith("E"))
    return { style: "decimal", notation: "scientific", minimumFractionDigits: parseIntDefault(f.after("E"), 6), maximumFractionDigits: parseIntDefault(f.after("E"), 6), useGrouping: false } as any;

  if (f.startsWith("P"))
    return { style: "percent", minimumFractionDigits: parseIntDefault(f.after("P"), 2), maximumFractionDigits: parseIntDefault(f.after("P"), 2), useGrouping: false };

  if (f.startsWith("K"))
    return { style: "decimal", minimumFractionDigits: parseIntDefault(f.after("K"), 2), maximumFractionDigits: parseIntDefault(f.after("K"), 2), notation: "compact", useGrouping: true };

  //simple heuristic
  var regex = /(?<plus>\+)?(?<body>[0#,.]+)(?<suffix>[%MKB])?/;
  const match = regex.exec(f);
  var body = match?.groups?.body ?? f;
  const suffix = match?.groups?.suffix;
  var afterDot = body.tryAfter(".") ?? "";
  const result: Intl.NumberFormatOptions = {
    style: suffix == "%" ? "percent" : "decimal",
    minimumFractionDigits: afterDot.replaceAll("#", "").length,
    maximumFractionDigits: afterDot.length,
    useGrouping: f.includes(","),
  };

  if (match?.groups?.plus)
    (result as any).signDisplay = "always";

  return result;
}

// Min/max range per altea value subTypeName (TypeReference.subTypeName) — the overflow guard for
// NumberLine. Keyed by the actual altea subTypeNames (int/long/decimal); a value with no subTypeName
// (plain "Number") isn't in the map ⇒ no guard.
export const numberLimits: {
  [subType: string]: { min: number, max: number }
} = {
  "int": { min: -2147483648, max: 2147483647 },
  "long": { min: -9223372036854775808, max: 9223372036854775807 },
  "decimal": { min: -79228162514264337593543950335, max: 79228162514264337593543950335 },
};
