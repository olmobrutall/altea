import type { Locator } from "@playwright/test";
import type { BaseEntity } from "@altea/altea/data/entity";
import { LineContainer } from "../Frames/LineContainer";
import { EntityRepeaterProxy } from "./EntityRepeaterProxy";
import { waitChanges, waitVisible } from "../PlaywrightExtensions";

// Port of Signum.Playwright's LineProxies/EntityTabRepeaterProxy.cs (EntityTabRepeater.tsx) — the same
// collection as an EntityRepeater, one TAB per element (altea keeps the `sf-repeater-element` class on the
// active pane, which is why this only has to add the tab click).
export class EntityTabRepeaterProxy extends EntityRepeaterProxy {

    get tabs(): Locator { return this.element.locator(".nav-tabs .nav-item .nav-link"); }

    /** Signum's `SelectTabAsync(index)` — show the nth element. */
    async selectTab(index: number): Promise<void> {
        await this.tabs.nth(index).click();
        await waitVisible(this.element.locator(".sf-repeater-element.active").first());
    }

    /** The lines of the ACTIVE element (only one pane is rendered at a time). */
    activeElement<T extends BaseEntity>(): LineContainer<T> {
        return new LineContainer<T>(this.element.locator(".sf-repeater-element.active").first(), this.itemRoute);
    }

    /** Signum's create + switch: add a tab and return the lines of the new (active) element. */
    override async createElement<T extends BaseEntity>(): Promise<LineContainer<T>> {
        await waitChanges(this.element, () => this.createButton.click());
        return this.activeElement<T>();
    }
}
