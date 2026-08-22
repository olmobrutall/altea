import type { Locator } from "@playwright/test";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import type { BaseEntity } from "@altea/altea/data/entity";
import { isPresent, waitNotPresent, waitVisible, type AsyncScoped } from "../PlaywrightExtensions";
import { EntityButtonContainer } from "./EntityButtonContainer";
import { LineContainer } from "./LineContainer";
import { MessageModalProxy } from "../ModalProxies/ModalProxy";

// Port of Signum.Playwright's Frames/FrameModalProxy.cs — an entity in a MODAL (what an EntityLine's
// create / view, or a search page's Create, opens).
//
// It is a SCOPE (see PlaywrightExtensions' AsyncScoped): the closure that receives it owns the open modal,
// and leaving the closure closes it — Signum's `DisposeAsync`, which clicks the header's ✕, answers a
// "discard changes?" confirmation with NO, and then runs `Disposing` so the LINE that opened the modal can
// wait for its own re-render. Both TypeScript spellings work:
//
//     await scoped(line.createModal(OrderEntity), async order => { … });   // Signum's `.Then(…)`
//     await using order = await line.createModal(OrderEntity);             // TS 5.2 `await using`
//
// `avoidClose` is Signum's flag for the case where the body already closed it (pressed OK / executed an
// operation that navigates away).
export class FrameModalProxy<T extends BaseEntity> extends EntityButtonContainer implements AsyncScoped {

    readonly lines: LineContainer<T>;

    /** Signum's `AvoidClose` — set it when the body closed the modal itself. */
    avoidClose = false;

    /** Signum's `Disposing` — what the OPENER wants to await once the modal is gone (the line's re-render). */
    disposing: ((okPressed: boolean) => Promise<void>) | undefined;

    private okPressed = false;
    private failure: unknown;

    private constructor(readonly modal: Locator, readonly route: PropertyRoute) {
        super();
        this.lines = new LineContainer<T>(modal, route);
    }

    /** Signum's `FrameModalProxy<T>.NewAsync(modal, route)`. */
    static async create<T extends BaseEntity>(modal: Locator, rootTypeOrRoute: Function | PropertyRoute): Promise<FrameModalProxy<T>> {
        const route = rootTypeOrRoute instanceof PropertyRoute ? rootTypeOrRoute : PropertyRoute.root(rootTypeOrRoute);
        await waitVisible(modal);
        const proxy = new FrameModalProxy<T>(modal, route);
        await waitVisible(proxy.mainControl);
        return proxy;
    }

    override get element(): Locator { return this.modal; }

    get okButton(): Locator { return this.modal.locator(".sf-entity-button.sf-ok-button, .sf-ok-button").first(); }
    get closeButton(): Locator { return this.modal.locator(".modal-header button.btn-close").first(); }
    get title(): Locator { return this.modal.locator(".modal-title").first(); }

    /** Accept the modal and wait for it to go away. */
    async ok(): Promise<void> {
        await this.okButton.click();
        await waitNotPresent(this.modal);
        this.okPressed = true;
        this.avoidClose = true;
    }

    /** Dismiss it (the header's ✕). */
    async cancel(): Promise<void> {
        await this.closeButton.click();
        await waitNotPresent(this.modal);
        this.avoidClose = true;
    }

    /** Signum's `OnException` — remember it, so the scope can leave the failure on screen. */
    onException(error: unknown): void { this.failure = error; }

    /** Signum's `DisposeAsync`: close what is still open, then let the opener settle. */
    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.avoidClose && this.failure == null) {
            try {
                if (await this.modal.isVisible()) {
                    if (await this.closeButton.isVisible())
                        await this.closeButton.click();

                    // Signum: a "discard your changes?" confirmation answers NO — the scope is unwinding,
                    // not saving.
                    const message = this.modal.page().locator(".modal.fade.show .message-modal").last();
                    if (await isPresent(message))
                        await new MessageModalProxy(message.locator("xpath=ancestor::div[contains(@class,'modal')][1]"))
                            .click("no").catch(() => { /* it may have closed on its own */ });

                    await waitNotPresent(this.modal).catch(() => { /* already gone */ });
                }
            } catch {
                // Closing is best-effort: a test that already navigated away must not fail on the way out.
            }
        }

        await this.disposing?.(this.okPressed);
    }
}
