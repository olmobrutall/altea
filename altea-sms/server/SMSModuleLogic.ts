import "@altea/altea/server";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { StablePromise } from "@altea/altea/server/stablePromise";
import type { SMSConfigurationEmbedded } from "../data/SMS";
import { SMSLogic, type ISMSProvider } from "./SMSLogic";
import { SMSProcessLogic } from "./SMSProcessLogic";
import { SMSServer } from "./SMSServer";

// The module's single entry point (the shape TreeModuleLogic / RestModuleLogic use), so an app writes one
// line and cannot half-install the module.
//
// The BATCH half is opt-out (`processes: false`): it pulls in @altea/altea-processes and
// @altea/altea-scheduler, and an app that only ever sends one message at a time needs neither.
export namespace SMSModuleLogic {

    export function start(
        sb: SchemaBuilder,
        options: {
            getConfiguration: () => StablePromise<SMSConfigurationEmbedded>;
            /** The gateway. Null is legitimate: a queue with no provider still records messages. */
            provider?: ISMSProvider;
            /** The send / update-status processes and the scheduled status refresh. Default: on. */
            processes?: boolean;
            /** The SMSModel registry — see SMSLogic.start. Default: on. */
            models?: boolean;
        },
    ): void {
        if (sb.alreadyDefined(start))
            return;

        SMSLogic.start(sb, {
            provider: options.provider,
            getConfiguration: options.getConfiguration,
            models: options.models,
        });

        if (options.processes !== false)
            SMSProcessLogic.start(sb);

        if (sb.webBuilder != null)
            SMSServer.start(sb.webBuilder);
    }
}
