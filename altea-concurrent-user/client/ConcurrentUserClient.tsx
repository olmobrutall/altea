import * as React from "react";
import { ajaxGet } from "@altea/altea/client/Services";
import { Navigator } from "@altea/altea/client/Navigator";
import { onWidgets } from "@altea/altea/client/Frames/Widgets";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { tryGetTypeInfo } from "@altea/altea/data/reflection";
import type { UserEntity } from "@altea/altea-auth/data/User";
import ConcurrentUser from "./ConcurrentUser";

// Registers the frame widget and the one API call.
//
// Port of Signum.ConcurrentUser's ConcurrentUserClient.tsx — see docs/port/ConcurrentUser.md.
export namespace ConcurrentUserClient {

    export function start(options?: { activatedFor?: (e: Entity) => boolean }): void {

        // Keep in sync with ConcurrentUserLogic.watchSaveFor!
        const activatedFor = options?.activatedFor ?? ((e: Entity) => {
            const kind = tryGetTypeInfo(e.constructor)?.entityKind;
            return !(kind === "System" || kind === "SystemString");
        });

        onWidgets().push(ctx => {
            const entity = ctx.ctx.value;

            if (entity instanceof Entity && !entity.isNew && activatedFor(entity))
                return <ConcurrentUser entity={entity}
                    isExecuting={ctx.frame.isExecuting()}
                    onReload={() => {
                        void Navigator.API.fetchEntityPack(entity.toLite()).then(pack => ctx.frame.onReload(pack));
                    }} />;

            return undefined;
        });
    }

    export namespace API {
        export function getUsers(key: string): Promise<ConcurrentUserResponse[]> {
            return ajaxGet({ url: "/api/concurrentUser/getUsers/" + encodeURIComponent(key) });
        }
    }

    export interface ConcurrentUserResponse {
        user: Lite<UserEntity>;
        startTime: string; // ISO — see the server DTO note
        connectionID: string;
        isModified: boolean;
    }
}
