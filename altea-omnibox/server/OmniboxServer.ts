import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import type { OmniboxRequest, OmniboxResult } from "../data/OmniboxResults";
import { OmniboxPermission } from "../data/OmniboxMessages";
import { OmniboxParser } from "./OmniboxParser";

// Port of Signum.Omnibox's OmniboxController + OmniboxServer — see port/Omnibox.md.
//
// ONE route: the client posts the raw query text plus the special-action keys it has registered, and gets
// back the ranked suggestions. The keys are forwarded through the explicit `OmniboxContext`.
//
// The ROUTE carries the gate. There is nothing to gate on the message container — it is a plain object
// bundled with the client, not an entry in the reflection blob.
export namespace OmniboxServer {
    export function start(ws: WebBuilder): void {
        ws.post("/api/omnibox",
            { req: CustomType<OmniboxRequest>(), res: CustomType<OmniboxResult[]>() },
            async (req, res) => {
                if (!(await PermissionLogic.isAuthorized(OmniboxPermission.ViewOmnibox)))
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
