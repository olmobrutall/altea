// Custom lite registry. A custom lite carries display fields directly on the lite instance
// (altea has no separate "model"). Multiple may be registered per entity type; on read the
// first whose isCompatible(json) returns true is chosen, else a plain LiteImp.

import { typeConstructor } from '../entity';
import type { Type, Entity } from '../entity';
import type { Lite } from '../lite';

export interface CustomLiteClass {
    isCompatible(json: Record<string, unknown>): boolean;
    fromJson(json: Record<string, unknown>): Lite<Entity>;
}

const customLiteRegistry = new Map<Function, CustomLiteClass[]>();

/** Registers a custom lite class for an entity type (registration order = match order). */
export function registerCustomLite(entityType: Type<Entity>, liteClass: CustomLiteClass): void {
    const ctor = typeConstructor(entityType);
    const arr = customLiteRegistry.get(ctor) ?? [];
    arr.push(liteClass);
    customLiteRegistry.set(ctor, arr);
}

/** The custom lite classes registered for a ctor, in registration (match) order. */
export function customLitesFor(ctor: Function): CustomLiteClass[] {
    return customLiteRegistry.get(ctor) ?? [];
}
