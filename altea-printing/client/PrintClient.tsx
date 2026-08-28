import * as React from "react";
import { ajaxGet, ajaxPost } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Operations, EntityOperationSettings } from "@altea/altea/client/Operations";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import type { FileTypeSymbol } from "@altea/altea-files/data/Files";
import type { ProcessEntity } from "@altea/altea-processes/data/Processes";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { registerSpecialAction } from "@altea/altea/client/OmniboxSpecialAction";
import {
    PrintLineEntity, PrintLineOperation, PrintPackageEntity, PrintPermission, type PrintStat,
} from "../data/Printing";

// Port of Signum.Printing's PrintClient.tsx — the two entity settings, the panel route, and the omnibox
// entry that reaches it.
//
// ALTEA: `isPermissionAuthorized` lives on @altea/altea-auth's client (the framework has no permission gate
// of its own — the flag rides on the permission container's metadata entry), the divergence altea-workflow
// documents.
export namespace PrintClient {

    export function start(cb: ClientBuilder): void {
        cb.routes.push({ path: "/printing/view", element: <ImportComponent onImport={() => import("./PrintPanelPage")} /> });

        cb.configure(PrintLineEntity)
            .withView(() => import("./Templates/PrintLine"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(l => l.creationDate),
                    token(l => l.file),
                    token(l => l.state),
                    token(l => l.package),
                    token(l => l.printedOn),
                    token(l => l.referred),
                ],
            }));

        cb.configure(PrintPackageEntity)
            .withView(() => import("./Templates/PrintPackage"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(p => p.id),
                    token(p => p.name),
                ],
            }));

        // Signum hides SaveTest once it cannot execute: a test line is saved once and then it is an ordinary
        // queued line.
        Operations.addSettings(new EntityOperationSettings(PrintLineOperation.SaveTest, { hideOnCanExecute: true }));

        registerSpecialAction({
            key: "PrintPanel",
            allowed: () => AuthClient.isPermissionAuthorized(PrintPermission.ViewPrintPanel),
            onClick: () => Promise.resolve("/printing/view"),
        });
    }

    export namespace API {
        export function getStats(): Promise<PrintStat[]> {
            return ajaxGet({ url: "/api/printing/stats" });
        }

        export function createPrintProcess(fileType: FileTypeSymbol | null): Promise<ProcessEntity | null> {
            return ajaxPost({ url: "/api/printing/createProcess" }, fileType);
        }
    }
}
