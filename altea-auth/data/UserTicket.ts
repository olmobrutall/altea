import { reflect } from "@altea/altea/data/reflection";
import { Entity, type PrimaryKey } from "@altea/altea/data/entity";
import { entity, ticksColumn } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import { Lite } from "@altea/altea/data/lite";
import { Temporal } from "@altea/altea/data/basics";
import { UserEntity } from "./User";

// Port of Signum.Authorization's UserTicket/UserTicket.cs — see port/Auth.md.
//
// The "remember me" credential. One row per
// remembered DEVICE: a long-lived random secret that a returning browser presents instead of a password,
// exchanged for a normal auth token at boot.
//
// It lives here, as it does in Signum.Authorization: the login flow is what consumes it, and
// `UserGraph`'s deactivate operations must be able to revoke tickets (see UserTicketLogic).
//
// altea divergences, documented inline:
//  - `ParseTicket` returns the pair rather than using C# named tuples, and parses the id through
//    `UserEntity.parseId` — so it respects the
//    user table's declared PK type instead of assuming an int.
//  - the regex is anchored and NON-greedy on the id half. Signum's `^(?<id>.*)\|(?<ticket>.*)$` is greedy,
//    so a ticket secret that itself contained a `|` would move the split point and silently mis-parse both
//    halves. The secret is a v4 GUID today, so this is latent there; anchoring the id to the digits/GUID
//    shape it actually has costs nothing and cannot mis-split.

@reflect
@entity("System", "Transactional")
// Engine-written rows, never edited by a person, so no concurrency stamp.
@ticksColumn(false)
export class UserTicketEntity extends Entity {
    user: Lite<UserEntity>;

    // Exactly 36 — the length of a hyphenated GUID, which is what `newTicket` generates.
    @stringLengthValidator({ min: 36, max: 36 })
    ticket: string;

    connectionDate: Temporal.PlainDateTime;

    @stringLengthValidator({ max: 200 })
    device: string;

    /** What the cookie carries: which user, and their secret. */
    stringTicket(): string {
        return `${this.user.id}|${this.ticket}`;
    }
}

/**
 * Throws when the text is not a ticket at all — the caller
 * (UserTicketLogic.updateTicket) treats that the same as a ticket that does not exist, so a tampered or
 * truncated cookie is simply not a login.
 */
export function parseTicket(ticket: string): { userId: PrimaryKey; ticket: string } {
    const m = /^([^|]*)\|(.*)$/.exec(ticket);
    if (m == null)
        throw new Error("The content of the ticket has an invalid format");
    return { userId: UserEntity.parseId(m[1]!), ticket: m[2]! };
}
