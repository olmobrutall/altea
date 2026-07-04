// Port of Signum's Signum.Entities.Reflection/StringHashEncoder — the hashing used to build
// deterministic, length-bounded database identifier names (indexes, FK/PK constraints). Kept
// byte-for-byte compatible with Signum so names are stable and predictable.

export const HASH_SIZE = 7;

// If `str` exceeds `maxLength`, chop it and append a short hash of the chopped-off tail so
// the result stays unique within the identifier limit. `lowercase` for Postgres.
export function chopHash(str: string, maxLength: number, lowercase: boolean): string {
    if (str.length > maxLength)
        return str.substring(0, maxLength - HASH_SIZE) + codify(str.substring(maxLength - HASH_SIZE), lowercase);
    return str;
}

const LETTERS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// A 7-char base-32 hash of `str` (Signum's Codify) — used both by chopHash and to build an
// index's WHERE/INCLUDE signature suffix.
export function codify(str: string, lowercase: boolean): string {
    let hash = getHashCode32(str);
    let sb = "";
    for (let i = 0; i < 32; i += 5) {
        sb += LETTERS[hash & 31];
        hash >>= 5;
    }
    return lowercase ? sb.toLowerCase() : sb;
}

// Signum's GetHashCode32 — a stable 32-bit string hash (independent of the runtime's own
// string hashing). Uses Int32 arithmetic (|0 / Math.imul) to match C# int overflow.
export function getHashCode32(value: string): number {
    let num = 0x15051505 | 0;
    let num2 = num;
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if ((i & 1) === 0)
            num = ((((num << 5) + num) | 0) + (num >> 0x1b)) ^ c;
        else
            num2 = ((((num2 << 5) + num2) | 0) + (num2 >> 0x1b)) ^ c;
    }
    return (num + Math.imul(num2, 0x5d588b65)) | 0;
}
