import "@altea/altea/server";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { SMSConfigurationEmbedded } from "../data/SMS";
import { SMSLogic, type ISMSProvider } from "./SMSLogic.server";
import { SMSProcessLogic } from "./SMSProcessLogic.server";
import { SMSServer } from "./SMSServer.server";

// The module's single entry point. Southwind calls `SMSLogic.Start(sb, provider, () => Configuration.Value.Sms)`
// and — in an app that uses the batch half — `SMSProcessLogic.Start(sb)`; altea packages expose one `start`
// per module (the shape TreeModuleLogic / RestModuleLogic use), so an app writes one line and cannot
// half-install it.
//
// The BATCH half is opt-out (`processes: false`): it pulls in @altea/altea-processes and
// @altea/altea-scheduler, and an app that only ever sends one message at a time needs neither.
export namespace SMSModuleLogic {

    export function start(
        sb: SchemaBuilder,
        options: {
            getConfiguration: () => SMSConfigurationEmbedded;
            /** Signum's `provider` argument. Southwind passes null — see SMSLogic's ISMSProvider note. */
            provider?: ISMSProvider;
            /** The send / update-status processes and the scheduled status refresh. Default: on. */
            processes?: boolean;
        },
    ): void {
        if (sb.alreadyDefined(start))
            return;

        SMSLogic.start(sb, { provider: options.provider, getConfiguration: options.getConfiguration });

        if (options.processes !== false)
            SMSProcessLogic.start(sb);

        if (sb.webBuilder != null)
            SMSServer.start(sb.webBuilder);
    }
}
