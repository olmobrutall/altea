import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import type { OmniboxRequest, OmniboxResult } from "../data/OmniboxResults";
import { OmniboxPermission } from "../data/OmniboxMessages";
import { OmniboxParser } from "./OmniboxParser";

// Port of Signum's `OmniboxController` + `OmniboxServer` (Signum.Omnibox). ONE route: the client posts
// the raw query text plus the special-action keys it has registered, and gets back the ranked suggestions.
//
// altea divergences:
//  - Signum's `ReflectionServer.RegisterLike(typeof(OmniboxMessage), …)` (gate the message enum out of the
//    reflection blob for unauthorized users) has no altea equivalent — altea's message containers are
//    plain objects bundled with the client, not blob entries. The ROUTE is still gated below, which is
//    what actually matters.
//  - Signum built a fresh `SpecialOmniboxGenerator<ReactSpecialOmniboxAction>` per request and pushed it
//    onto an AsyncThreadVariable; altea passes the keys through the explicit `OmniboxContext` instead
//    (see OmniboxParser), so this handler just forwards them.
export namespace OmniboxServer {
    export function start(ws: WebBuilder): void {
        ws.post("/api/omnibox",
            { req: CustomType<OmniboxRequest>(), res: CustomType<OmniboxResult[]>() },
            async (req, res) => {
                if (!(await PermissionAuthLogic.isAuthorized(OmniboxPermission.ViewOmnibox)))
                    throw new UnauthorizedAccessException(`Not authorized for '${OmniboxPermission.ViewOmnibox.key}'`);

                const request = (await req.jsonTyped()) as OmniboxRequest | undefined;

                const results = await OmniboxParser.results(request?.query ?? "", {
                    specialActions: request?.specialActions ?? [],
                });

                // jsonTyped (not json): a result may carry a Lite, which must go out in altea's wire form.
                res.jsonTyped(results);
            });
    }
}
