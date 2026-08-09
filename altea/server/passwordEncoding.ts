import { pbkdf2Sync, createHash } from "node:crypto";

// Port of Signum's PasswordEncoding (Signum/Security/PasswordEncoding.cs). Server-only (uses
// node:crypto — no new dependency). Both hooks are mutable `let`s, exactly as Signum's public delegates,
// so a host can swap the hashing scheme without touching call sites.
//
// - HashPassword: PBKDF2-HMAC-SHA256, salt = UTF-8(username), 100_000 iterations, 32-byte (256-bit) key.
//   Identical parameters to Signum's Rfc2898DeriveBytes.Pbkdf2, so hashes are byte-compatible with a
//   Signum-produced database.
// - HashPasswordAlternatives: legacy MD5 (backwards-compatibility only — NEVER for new passwords), so an
//   old Signum DB's MD5 hashes still validate on login and get upgraded on the next change.

export type HashPasswordDelegate = (usernameForSalt: string, password: string) => Buffer;
export type HashPasswordAlternativesDelegate = (usernameForSalt: string, password: string) => Buffer[];

export namespace PasswordEncoding {
    export let hashPassword: HashPasswordDelegate =
        (usernameForSalt, originalPassword) => pbkdf2Hash(originalPassword, usernameForSalt, 100_000);

    export let hashPasswordAlternatives: HashPasswordAlternativesDelegate =
        (_usernameForSalt, originalPassword) => [md5Hash(originalPassword)]; // Backwards compatibility only

    export function pbkdf2Hash(password: string, salt: string, iterations: number): Buffer {
        return pbkdf2Sync(password, Buffer.from(salt, "utf8"), iterations, 32, "sha256");
    }

    // Obsolete, for backwards compatibility only. Do not use for new passwords.
    export function md5Hash(saltedPassword: string): Buffer {
        return createHash("md5").update(Buffer.from(saltedPassword, "utf8")).digest();
    }

    /** Constant-time-ish comparison of two hashes (Signum's `.SequenceEqual`). */
    export function sequenceEqual(a: Buffer | null | undefined, b: Buffer | null | undefined): boolean {
        if (a == null || b == null || a.length !== b.length)
            return false;
        let diff = 0;
        for (let i = 0; i < a.length; i++)
            diff |= a[i] ^ b[i];
        return diff === 0;
    }
}
