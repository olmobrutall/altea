import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { TourEntity } from "./Tour";

/** The flattened tour the player consumes, with each step's selector already resolved. */
export interface TourDTO {
    tour: Lite<TourEntity>;
    forEntity: Lite<Entity>;
    steps: TourStepDTO[];
    showProgress: boolean;
    animate: boolean;
    showCloseButton: boolean;
}

export interface TourStepDTO {
    cssSelector: string | null;
    title: string;
    description: string;
    side: string | null;
    align: string | null;
    /** The ClickTrigger member NAME ("OnLoad" / "OnNext"). */
    click: string | null;
}
