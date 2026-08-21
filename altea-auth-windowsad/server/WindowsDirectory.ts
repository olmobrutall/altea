import { Client, InvalidCredentialsError } from "ldapts";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { WindowsADConfigurationEmbedded } from "../data/WindowsAD";

// The LDAP substrate that replaces `System.DirectoryServices` / `System.DirectoryServices.AccountManagement`
// in Signum.Authorization.WindowsAD.
//
// WHY LDAP: `PrincipalContext` / `UserPrincipal` / `DirectorySearcher` are Windows-only .NET APIs with no
// Node equivalent. Every operation the module needs — validate a credential, find a user, read their
// transitive groups, read their thumbnail photo, check whether the account is enabled — IS an LDAP operation
// against a domain controller, which is what those APIs do underneath. So the port keeps the SEMANTICS and
// changes the transport.
//
// The three translations worth knowing:
//  - `pc.ValidateCredentials(user, password, Negotiate)` → an LDAP SIMPLE BIND as `user@domain`. A bind that
//    succeeds proves the password; `InvalidCredentialsError` proves it wrong; anything else (host down, TLS)
//    is an infrastructure error and must NOT be reported as a bad password.
//  - `UserPrincipal.GetGroups()` (which is TRANSITIVE) → a group search with AD's
//    `LDAP_MATCHING_RULE_IN_CHAIN` (`member:1.2.840.113556.1.4.1941:=<userDN>`). A plain `memberOf` read
//    would only find DIRECT membership, which would silently narrow every role mapping that relies on a
//    nested group.
//  - `foundUser.Enabled` → bit 2 (ACCOUNTDISABLE) of `userAccountControl`.
//
// `objectSid` arrives as raw bytes and must be formatted as the canonical `S-1-5-21-…` string, because that
// string is what `UserEntity.externalId` stores (Signum writes `SecurityIdentifier.ToString()`).

/** One directory user, in the fields this module reads. */
export interface DirectoryUser {
    dn: string;
    sAMAccountName: string | null;
    userPrincipalName: string | null;
    displayName: string | null;
    description: string | null;
    givenName: string | null;
    surname: string | null;
    mail: string | null;
    /** The canonical SID string (`S-1-5-21-…`) — what `externalId` stores. */
    sid: string | null;
    /** Whether the account is enabled (`userAccountControl` bit 2 clear). Null when unreadable. */
    enabled: boolean | null;
}

/** One directory group. */
export interface DirectoryGroupEntry {
    dn: string;
    name: string | null;
    /** The group's `objectGUID` as a lower-case uuid — what a `roleMapping` entry may name it by. */
    guid: string | null;
}

const userAttributes = [
    "distinguishedName", "sAMAccountName", "userPrincipalName", "displayName", "description",
    "givenName", "sn", "mail", "objectSid", "userAccountControl",
];

export namespace WindowsDirectory {

    /**
     * Run `fn` with a connected, BOUND client. Binds as the configured lookup account when there is one,
     * else anonymously (which works when the host process itself is a domain member and the directory allows
     * it — Signum's `new PrincipalContext(ContextType.Domain, domainName)`).
     */
    export async function withClient<R>(config: WindowsADConfigurationEmbedded, fn: (client: Client) => Promise<R>): Promise<R> {
        const client = new Client({ url: config.getLdapUrl() });
        try {
            const bindName = config.getRegistryBindName();
            if (bindName != null && config.directoryRegistry_Password != null)
                await client.bind(bindName, config.directoryRegistry_Password);

            return await fn(client);
        } finally {
            await client.unbind().catch(() => { /* the connection is going away anyway */ });
        }
    }

    /**
     * Signum's `pc.ValidateCredentials(userName, password, ContextOptions.Negotiate)` — true when the
     * password is right, false when it is wrong. Throws for anything that is NOT a credential problem, so a
     * domain controller being unreachable never looks like a bad password.
     */
    export async function validateCredentials(config: WindowsADConfigurationEmbedded, userName: string, password: string): Promise<boolean> {
        using _prof = HeavyProfiler.log("LDAP", () => "bind " + userName);

        // An EMPTY password must never be sent: an LDAP simple bind with no password is an ANONYMOUS bind,
        // which typically succeeds — and would authenticate anybody.
        if (password === "")
            return false;

        const client = new Client({ url: config.getLdapUrl() });
        try {
            await client.bind(bindNameFor(config, userName), password);
            return true;
        } catch (e) {
            if (e instanceof InvalidCredentialsError)
                return false;
            throw e;
        } finally {
            await client.unbind().catch(() => { /* ignore */ });
        }
    }

    /** Signum's `UserPrincipal.FindByIdentity(pc, IdentityType.SamAccountName, name)`. */
    export async function findByIdentity(config: WindowsADConfigurationEmbedded, identity: string): Promise<DirectoryUser | null> {
        const local = localNameOf(identity);
        const filter = `(&(objectCategory=person)(objectClass=user)(|(sAMAccountName=${escapeFilter(local)})`
            + `(userPrincipalName=${escapeFilter(identity)})))`;

        const found = await search(config, filter, 1);
        return found[0] ?? null;
    }

    /** Signum's `WindowsADLogic.SearchUser(searchUserName, limit)`. */
    export async function searchUsers(config: WindowsADConfigurationEmbedded, subString: string, limit: number): Promise<DirectoryUser[]> {
        const s = escapeFilter(subString);
        const clauses = [`(sAMAccountName=*${s}*)`, `(displayName=*${s}*)`];
        if (subString.includes("@"))
            clauses.push(`(mail=${s})`);

        const filter = `(&(objectCategory=person)(objectClass=user)(|${clauses.join("")}))`;

        const found = await search(config, filter, limit);

        // Signum's `.DistinctBy(a => a.ExternalId).OrderBy(a => a.UPN)`.
        const bySid = new Map<string, DirectoryUser>();
        for (const u of found)
            if (!bySid.has(u.sid ?? u.dn))
                bySid.set(u.sid ?? u.dn, u);

        return [...bySid.values()].sort((a, b) => (a.userPrincipalName ?? "").localeCompare(b.userPrincipalName ?? ""));
    }

    /**
     * Signum's `UserPrincipal.GetGroups(pc)` — the user's TRANSITIVE group membership, via AD's
     * `LDAP_MATCHING_RULE_IN_CHAIN` (see the header on why `memberOf` is not enough).
     */
    export async function getGroups(config: WindowsADConfigurationEmbedded, userDN: string): Promise<DirectoryGroupEntry[]> {
        using _prof = HeavyProfiler.log("LDAP", () => "groups of " + userDN);

        return await withClient(config, async client => {
            const { searchEntries } = await client.search(config.getBaseDN(), {
                filter: `(&(objectClass=group)(member:1.2.840.113556.1.4.1941:=${escapeFilter(userDN)}))`,
                attributes: ["distinguishedName", "cn", "objectGUID"],
                explicitBufferAttributes: ["objectGUID"],
            });

            return searchEntries.map(e => ({
                dn: String(e["dn"] ?? e["distinguishedName"] ?? ""),
                name: firstString(e["cn"]),
                guid: formatObjectGuid(e["objectGUID"]),
            }));
        });
    }

    /** Signum's `directoryEntry.Properties["thumbnailPhoto"][0]`. */
    export async function getThumbnailPhoto(config: WindowsADConfigurationEmbedded, userName: string): Promise<Buffer | null> {
        using _prof = HeavyProfiler.log("LDAP", () => "thumbnailPhoto of " + userName);

        return await withClient(config, async client => {
            const { searchEntries } = await client.search(config.getBaseDN(), {
                filter: `(&(objectCategory=person)(objectClass=user)(|(sAMAccountName=${escapeFilter(localNameOf(userName))})`
                    + `(userPrincipalName=${escapeFilter(userName)})))`,
                attributes: ["thumbnailPhoto"],
                explicitBufferAttributes: ["thumbnailPhoto"],
                sizeLimit: 1,
            });

            const raw = searchEntries[0]?.["thumbnailPhoto"];
            return Buffer.isBuffer(raw) ? raw : Array.isArray(raw) && Buffer.isBuffer(raw[0]) ? raw[0] : null;
        });
    }

    async function search(config: WindowsADConfigurationEmbedded, filter: string, sizeLimit: number): Promise<DirectoryUser[]> {
        using _prof = HeavyProfiler.log("LDAP", () => filter);

        return await withClient(config, async client => {
            const { searchEntries } = await client.search(config.getBaseDN(), {
                filter,
                attributes: userAttributes,
                explicitBufferAttributes: ["objectSid"],
                sizeLimit,
            });

            return searchEntries.map(e => {
                const uac = firstString(e["userAccountControl"]);
                return {
                    dn: String(e["dn"] ?? e["distinguishedName"] ?? ""),
                    sAMAccountName: firstString(e["sAMAccountName"]),
                    userPrincipalName: firstString(e["userPrincipalName"]),
                    displayName: firstString(e["displayName"]),
                    description: firstString(e["description"]),
                    givenName: firstString(e["givenName"]),
                    surname: firstString(e["sn"]),
                    mail: firstString(e["mail"]),
                    sid: formatSid(e["objectSid"]),
                    // ACCOUNTDISABLE = 0x2.
                    enabled: uac == null ? null : (Number(uac) & 0x2) === 0,
                };
            });
        });
    }

    /** Signum binds as `user@domain`; a name that already carries a domain (UPN or DOMAIN\user) is left be. */
    function bindNameFor(config: WindowsADConfigurationEmbedded, userName: string): string {
        return userName.includes("@") || userName.includes("\\")
            ? userName
            : `${userName}@${config.domainName}`;
    }
}

/**
 * Signum's `userName.TryBeforeLast('@') ?? userName.TryAfter('\\') ?? userName` — the sAMAccountName inside
 * a UPN or a `DOMAIN\user`.
 */
export function localNameOf(userName: string): string {
    const at = userName.lastIndexOf("@");
    if (at >= 0)
        return userName.substring(0, at);

    const slash = userName.indexOf("\\");
    if (slash >= 0)
        return userName.substring(slash + 1);

    return userName;
}

/** RFC 4515 filter escaping — without it a name containing `(`, `*` or `\` changes the filter's meaning. */
export function escapeFilter(value: string): string {
    return value.replace(/[\\*()\0]/g, c => "\\" + c.charCodeAt(0).toString(16).padStart(2, "0"));
}

/**
 * Format a binary `objectSid` as the canonical string .NET's `SecurityIdentifier.ToString()` produces:
 * `S-<revision>-<authority>-<subauthority>-…`. This IS the value stored in `UserEntity.externalId`, so the
 * format has to match exactly or an existing Signum database stops matching its own users.
 */
export function formatSid(raw: unknown): string | null {
    const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) && Buffer.isBuffer(raw[0]) ? raw[0] : null;
    if (buf == null || buf.length < 8)
        return null;

    const revision = buf[0]!;
    const subAuthorityCount = buf[1]!;
    // The identifier authority is a 48-bit BIG-endian value in bytes 2..7.
    let authority = 0;
    for (let i = 2; i < 8; i++)
        authority = authority * 256 + buf[i]!;

    const parts = [`S-${revision}-${authority}`];
    for (let i = 0; i < subAuthorityCount; i++) {
        const offset = 8 + i * 4;
        if (offset + 4 > buf.length)
            break;
        // Sub-authorities are 32-bit LITTLE-endian, and unsigned.
        parts.push(String(buf.readUInt32LE(offset)));
    }

    return parts.join("-");
}

/**
 * Format a binary `objectGUID` as a lower-case uuid. AD stores it in the same mixed-endian layout as a
 * Windows GUID (first three groups little-endian), which is what `Guid.ToString()` prints — so a
 * `roleMapping` entry copied out of a Windows tool matches.
 */
export function formatObjectGuid(raw: unknown): string | null {
    const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) && Buffer.isBuffer(raw[0]) ? raw[0] : null;
    if (buf == null || buf.length < 16)
        return null;

    const hex = (b: number): string => buf[b]!.toString(16).padStart(2, "0");
    return [
        hex(3) + hex(2) + hex(1) + hex(0),
        hex(5) + hex(4),
        hex(7) + hex(6),
        hex(8) + hex(9),
        hex(10) + hex(11) + hex(12) + hex(13) + hex(14) + hex(15),
    ].join("-");
}

function firstString(value: unknown): string | null {
    if (value == null)
        return null;
    if (typeof value === "string")
        return value === "" ? null : value;
    if (Array.isArray(value)) {
        const first = value.find(v => typeof v === "string");
        return first == null || first === "" ? null : first as string;
    }
    if (Buffer.isBuffer(value))
        return value.toString("utf8");
    return String(value);
}
