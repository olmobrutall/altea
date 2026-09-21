import { reflect } from "@altea/altea/data/reflection";
import { EmbeddedEntity } from "@altea/altea/data/entity";
import { unit } from "@altea/altea/data/decorators";
import { dateInPastValidator } from "@altea/altea/data/validators";
import { Temporal, type int, toInt } from "@altea/altea/data/basics";

/**
 * How long an auth TOKEN stays fresh — the settings half of AuthTokenServer.
 *
 * A member of the application's configuration row, like every other module's settings, so an
 * administrator can change either without a redeploy. What CANNOT live here is the encryption key the
 * token is signed with: it is needed to read the very first request, before any row can be loaded, so it
 * stays in the environment (`AUTH_TOKEN_KEY`).
 */
@reflect
export class AuthTokenConfigurationEmbedded extends EmbeddedEntity {

    /** How old a token may get before the next request is answered with a fresh one. */
    @unit("mins")
    refreshTokenEvery: int = toInt(30);

    /**
     * A kill switch: every token minted BEFORE this instant is refreshed on its next use, whatever its
     * age. Set it to "now" to roll the whole estate over — after a role change that must take effect
     * immediately, say, since a token carries the role it was minted with.
     *
     * In the PAST by definition; a future value would refresh every token on every request.
     */
    @dateInPastValidator()
    refreshAnyTokenPreviousTo: Temporal.PlainDateTime | null = null;
}
