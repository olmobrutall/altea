import * as React from "react";
import type { Entity, Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { BigValuePartEntity } from "../data/DashboardParts";

// Port of Signum's Signum.UserQueries/BigValueClient.tsx — the app-side registry that lets a BigValue part
// override its VALUE and/or its MESSAGE with a computed one (`customBigValue` names the registration).
// altea divergence: keyed by the entity ctor NAME (Signum used `Type.typeName` / `lite.EntityType`).

interface CustomMessageContext<T extends Entity> {
    content: BigValuePartEntity;
    entity?: Lite<T>;
    value?: unknown;
}

interface CustomBigValue<T extends Entity> {
    customMessage?: (c: CustomMessageContext<T>) => React.ReactNode;
    customValue?: (c: CustomMessageContext<T>) => React.ReactNode;
}

export namespace BigValueClient {
    export const customBigValues: Record<string, Record<string, CustomBigValue<Entity>>> = {};

    export function registerCustomBigValue<T extends Entity>(entityType: Type<T> | undefined, messageName: string, customBigValue: CustomBigValue<T>): void {
        (customBigValues[entityType?.name ?? "global"] ??= {})[messageName] = customBigValue as CustomBigValue<Entity>;
    }

    export function getKeys(entityTypeName: string | undefined): string[] {
        return Object.keys(customBigValues[entityTypeName ?? "global"] ?? {});
    }

    export function renderCustomBigValue(messageName: string, ctx: CustomMessageContext<Entity>): { message?: React.ReactNode, value?: React.ReactNode } {
        const typeName = ctx.entity?.entityType.name ?? "global";
        const cm = customBigValues[typeName]?.[messageName];
        if (cm == null)
            return {
                message: <span className="text-danger">No CustomMessage {messageName} registered for {typeName}</span>,
            };

        return {
            message: cm.customMessage?.(ctx),
            value: cm.customValue?.(ctx),
        };
    }
}
