// Port of Signum's NaturalLanguage tools (Signum.Utilities/NaturalLanguage/*): per-culture pluralizers
// and gender detectors for entity nice names. English / Spanish / German — the cultures Signum ships
// plural + gender rules for. Used by DescriptionManager.nicePluralName / gender as the fallback when a
// translation file carries no explicit PluralDescription / Gender. (Signum's NumberWriter is out of scope.)

export type Gender = "m" | "f" | "n";

export interface Pluralizer { makePlural(singular: string): string; }
export interface GenderDetector {
    getGender(name: string): Gender | undefined;
    readonly determiners: readonly { gender: Gender; singular: string; plural: string }[];
}

// ---- English (EnglishPluralizer) --------------------------------------------------------------
class EnglishPluralizer implements Pluralizer {
    // singular-suffix → plural-suffix. Signum keys these in a Dictionary and takes the first EndsWith;
    // we sort LONGEST-first so a specific suffix (ss/sh/ch) beats a general one (s), avoiding the
    // insertion-order quirk that would leave "class"/"address" unchanged.
    private readonly exceptions: ReadonlyArray<[string, string]> = ([
        ["ch", "ches"], ["eau", "eaus"], ["en", "ens"], ["ex", "exes"], ["f", "ves"], ["fe", "ves"],
        ["ieu", "ieus"], ["is", "is"], ["ix", "ixes"], ["nx", "nxes"], ["s", "s"], ["sh", "shes"],
        ["us", "us"], ["x", "xes"], ["ey", "eys"], ["ay", "ays"], ["oy", "oys"], ["uy", "uys"],
        ["y", "ies"], ["ss", "sses"],
    ] as [string, string][]).slice().sort((a, b) => b[0].length - a[0].length);

    makePlural(name: string): string {
        if (!name) return name;
        const i = name.lastIndexOf(" ");
        if (i !== -1) return name.slice(0, i + 1) + this.makePlural(name.slice(i + 1));
        const ex = this.exceptions.find(([k]) => name.endsWith(k));
        if (ex != null) return name.slice(0, name.length - ex[0].length) + ex[1];
        return name + "s";
    }
}

// ---- Spanish (SpanishPluralizer / SpanishGenderDetector) ---------------------------------------
class SpanishPluralizer implements Pluralizer {
    private readonly exceptions: ReadonlyArray<[string, string]> = ([
        ["x", "x"], ["s", "s"], ["z", "ces"], ["g", "gues"], ["c", "ques"], ["t", "ts"],
        ["án", "anes"], ["én", "enes"], ["ín", "ines"], ["ón", "ones"], ["ún", "unes"],
    ] as [string, string][]).slice().sort((a, b) => b[0].length - a[0].length);
    private readonly vowels = new Set([..."aeiouáéíóú"]);

    makePlural(name: string): string {
        if (!name) return name;
        const i = name.indexOf(" "); // Spanish pluralises the FIRST word
        if (i !== -1) return this.makePlural(name.slice(0, i)) + name.slice(i);
        const ex = this.exceptions.find(([k]) => name.endsWith(k));
        if (ex != null) return name.slice(0, name.length - ex[0].length) + ex[1];
        return this.vowels.has(name[name.length - 1]) ? name + "s" : name + "es";
    }
}

class SpanishGenderDetector implements GenderDetector {
    // Order is hand-tuned (roughly longest-first) — kept as Signum's dictionary order.
    private readonly terminations: ReadonlyArray<[string, Gender]> = [
        ["umbre", "f"], ["ión", "f"], ["dad", "f"], ["tad", "f"], ["ie", "f"], ["is", "f"],
        ["pa", "f"], ["ma", "f"], ["a", "f"], ["n", "m"], ["o", "m"], ["r", "m"], ["s", "m"], ["e", "m"], ["l", "m"],
    ];
    getGender(name: string): Gender | undefined {
        if (!name) return undefined;
        const first = name.includes(" ") ? name.slice(0, name.indexOf(" ")) : name;
        return this.terminations.find(([k]) => first.endsWith(k))?.[1];
    }
    readonly determiners = [
        { gender: "m" as Gender, singular: "el", plural: "los" },
        { gender: "f" as Gender, singular: "la", plural: "las" },
    ];
}

// ---- German (GermanGenderDetector / GermanPluralizer) ------------------------------------------
class GermanGenderDetector implements GenderDetector {
    // Signum does OrderByDescending(Key.Length): a longer suffix wins.
    private readonly terminations: ReadonlyArray<[string, Gender]> = ([
        ["ich", "m"], ["ist", "m"], ["or", "m"], ["ig", "m"], ["ling", "m"], ["ismus", "m"], ["ant", "m"],
        ["är", "m"], ["eur", "m"], ["iker", "m"], ["ps", "m"], ["typ", "m"], ["code", "m"],
        ["ei", "f"], ["ung", "f"], ["in", "f"], ["heit", "f"], ["keit", "f"], ["ion", "f"], ["ie", "f"],
        ["schaft", "f"], ["elle", "f"], ["ik", "f"], ["ur", "f"], ["ade", "f"], ["age", "f"], ["ette", "f"],
        ["enz", "f"], ["ere", "f"], ["ine", "f"], ["isse", "f"], ["tät", "f"], ["itis", "f"], ["ive", "f"],
        ["se", "f"], ["sis", "f"], ["e", "f"], ["art", "f"],
        ["chen", "n"], ["lein", "n"], ["ett", "n"], ["ium", "n"], ["ment", "n"], ["tum", "n"], ["eau", "n"],
    ] as [string, Gender][]).slice().sort((a, b) => b[0].length - a[0].length);

    getGender(name: string): Gender | undefined {
        if (!name) return undefined;
        const last = name.includes(" ") ? name.slice(name.lastIndexOf(" ") + 1) : name;
        return this.terminations.find(([k]) => last.endsWith(k))?.[1];
    }
    readonly determiners = [
        { gender: "m" as Gender, singular: "der", plural: "die" },
        { gender: "f" as Gender, singular: "die", plural: "die" },
        { gender: "n" as Gender, singular: "das", plural: "die" },
    ];
}

class GermanPluralizer implements Pluralizer {
    constructor(private readonly gender: GenderDetector) { }
    // Keep Signum's order — the "" (empty) key is LAST so it is the per-gender default (endsWith("") is
    // always true).
    private readonly feminine: ReadonlyArray<[string, string]> = [
        ["itis", "itiden"], ["sis", "sen"], ["xis", "xien"], ["in", "innen"], ["aus", "äuse"], ["e", "en"], ["a", "en"], ["", "en"],
    ];
    private readonly masculine: ReadonlyArray<[string, string]> = [
        ["ant", "anten"], ["ent", "enten"], ["ist", "isten"], ["at", "aten"], ["us", "usse"], ["e", "en"], ["", "e"],
    ];
    private readonly neuter: ReadonlyArray<[string, string]> = [
        ["nis", "nisse"], ["um", "a"], ["o", "en"], ["", "e"],
    ];

    makePlural(name: string): string {
        if (!name) return name;
        const i = name.lastIndexOf(" ");
        if (i !== -1) return name.slice(0, i) + " " + this.makePlural(name.slice(i + 1));
        const g = this.gender.getGender(name);
        const dic = g === "f" ? this.feminine : g === "m" ? this.masculine : g === "n" ? this.neuter : undefined;
        if (dic == undefined) return name;
        const ex = dic.find(([k]) => name.endsWith(k));
        return ex != undefined ? name.slice(0, name.length - ex[0].length) + ex[1] : name;
    }
}

// ---- Registry (NaturalLanguageTools) ----------------------------------------------------------
const _germanGender = new GermanGenderDetector();
const _spanishGender = new SpanishGenderDetector();

const _pluralizers: Record<string, Pluralizer> = {
    en: new EnglishPluralizer(),
    es: new SpanishPluralizer(),
    de: new GermanPluralizer(_germanGender),
};
const _genderDetectors: Record<string, GenderDetector> = {
    es: _spanishGender,
    de: _germanGender,
};

function twoLetter(locale: string): string { return locale.split("-")[0].toLowerCase(); }

// Signum's NaturalLanguageTools.Pluralize — the plural of a name for a culture (identity if unknown).
export function pluralize(singularName: string, locale: string): string {
    return _pluralizers[twoLetter(locale)]?.makePlural(singularName) ?? singularName;
}

// Signum's NaturalLanguageTools.GetGender — the grammatical gender of a name for a culture (English
// has none, so undefined).
export function detectGender(name: string, locale: string): Gender | undefined {
    return _genderDetectors[twoLetter(locale)]?.getGender(name);
}

// The definite article for a gender + number (Signum's GetDeterminer): "el"/"los", "die"/"die", …
export function getDeterminer(gender: Gender | undefined, plural: boolean, locale: string): string | undefined {
    const d = _genderDetectors[twoLetter(locale)]?.determiners.find(p => p.gender === gender);
    return d == undefined ? (twoLetter(locale) === "en" ? "the" : undefined) : (plural ? d.plural : d.singular);
}
