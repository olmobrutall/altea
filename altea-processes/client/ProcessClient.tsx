import * as React from "react";
import { ajaxGet, ajaxPost } from "@altea/altea/client/Services";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import {
    ProcessEntity, ProcessAlgorithmSymbol, ProcessExceptionLineEntity, ProcessPermission,
} from "../data/Processes";
import { PackageEntity, PackageOperationEntity, PackageLineEntity } from "../data/Package";
import type { ProcessLogicState } from "../data/ProcessLogicState";
import { registerSpecialAction } from "@altea/altea/client/OmniboxSpecialAction";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";

// The panel route, the Process editor, and the typed HTTP client the panel calls.
//
// The PackageOperation CONTEXTUAL MENU — pick rows in a search, run an operation over them as a process —
// is NOT ported; an app builds its packages in code. See docs/port/Processes.md.

export namespace ProcessClient {

    export function start(cb: ClientBuilder): void {
        cb.routes.push(
            { path: "/processes/view", element: <ImportComponent onImport={() => import("./ProcessPanelPage")} /> },
        );

        registerSpecialAction({
            key: "ProcessPanel",
            allowed: () => AuthClient.isPermissionAuthorized(ProcessPermission.ViewProcessPanel),
            onClick: () => Promise.resolve("/processes/view"),
        });

        cb.configure(ProcessEntity)
            .withView(() => import("./Templates/Process"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(p => p.id),
                    token(p => p.algorithm),
                    token(p => p.data),
                    token(p => p.state),
                    token(p => p.machineName),
                    token(p => p.creationDate),
                    token(p => p.executionStart),
                    token(p => p.executionEnd),
                    token(p => p.progress),
                ],
            }));

        cb.configure(ProcessAlgorithmSymbol)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.key),
                ],
            }));

        cb.configure(ProcessExceptionLineEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(l => l.id),
                    token(l => l.process),
                    token(l => l.line),
                    token(l => l.exception),
                ],
            }));

        cb.configure(PackageEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(p => p.id),
                    token(p => p.name),
                ],
            }));
        cb.configure(PackageOperationEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(p => p.id),
                    token(p => p.operation),
                    token(p => p.name),
                ],
            }));
        cb.configure(PackageLineEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(l => l.id),
                    token(l => l.package),
                    token(l => l.target),
                    token(l => l.result),
                    token(l => l.finishTime),
                ],
            }));
    }

    export namespace API {

        export function view(): Promise<ProcessLogicState> {
            return ajaxGet({ url: "/api/processes/view", avoidNotifyPendingRequests: true });
        }

        export function start(): Promise<ProcessLogicState> {
            return ajaxPost({ url: "/api/processes/start" }, undefined);
        }

        export function stop(): Promise<ProcessLogicState> {
            return ajaxPost({ url: "/api/processes/stop" }, undefined);
        }
    }
}
