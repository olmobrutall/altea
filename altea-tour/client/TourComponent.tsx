import * as React from "react";
import { type Alignment, type Driver, driver, type DriveStep, type Side } from "driver.js";
import "driver.js/dist/driver.css";
import { micromark } from "micromark";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBiking } from "@fortawesome/free-solid-svg-icons";
import { Navigator } from "@altea/altea/client/Navigator";
import * as AppContext from "@altea/altea/client/AppContext";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { useAPI } from "@altea/altea/client/Hooks";
import { getTypeName, type PseudoType } from "@altea/altea/client/Reflection";
import { classes } from "@altea/altea/data/globals/helpers";
import { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { Symbol } from "@altea/altea/data/symbol";
import { TourTriggerSymbol } from "@altea/altea/data/tourTrigger";
import { TourEntity, TourMessage } from "../data/Tour";
import { TourClient } from "./TourClient";
import type { TourDTO } from "./TourClient";

// Port of Signum.Tour's TourComponent.tsx — the button that offers / replays a tour, and the driver.js
// wrapper that plays it. driver.js is pinned to Signum's own range (^1.3.1 → 1.3.6) so the popover
// behaviour is the one the steps were authored against.
//
// altea divergences:
//  - `isLite(x)` / `TourTriggerSymbol.isInstance(x)` → `x instanceof Lite` / `instanceof TourTriggerSymbol`
//    (altea's Lite and Symbol are real classes).
//  - `Navigator.API.getType(name)` → the byEntity route already takes the clean NAME, and the "create a
//    tour for this type" path resolves the TypeEntity through `TourClient.API.typeLite` rather than a
//    generic getType (altea's Navigator has no such call).
//  - `ChangeLogClient` is not ported (altea has no change-log module), so no changelog registration.

/**
 * Signum's TourButton — the "?"-ish bike icon beside a page. Three states:
 *   • a tour exists → play it (and Ctrl/Alt-click to edit it);
 *   • no tour, and the user may create one → offer to author it;
 *   • no tour, and the user may not → render nothing.
 */
export function TourButton(p: { trigger: PseudoType | Symbol | Lite<Entity>; className?: string }): React.JSX.Element | null {

    const storageKey =
        p.trigger instanceof Lite ? `tour-viewed-${p.trigger.key()}` :
            p.trigger instanceof Symbol ? `tour-viewed-${p.trigger.key}` :
                `tour-viewed-${getTypeName(p.trigger as PseudoType)}`;

    const [hasViewed, setHasViewed] = React.useState(() => localStorage.getItem(storageKey) === "true");
    // Bumped on every click so the player REMOUNTS and replays from step one.
    const [tourRunId, setTourRunId] = React.useState(0);

    const tour = useAPI(() => {
        if (p.trigger instanceof Lite)
            return TourClient.API.getTourByLite(p.trigger);
        if (p.trigger instanceof TourTriggerSymbol)
            return TourClient.API.getTourBySymbol(p.trigger.key);
        return TourClient.API.getTourByEntity(getTypeName(p.trigger as PseudoType));
    }, [p.trigger]);

    if (tour === undefined)
        return null; // still loading

    if (tour === null)
        return <CreateTourButton trigger={p.trigger} className={p.className} />;

    const canEdit = !Navigator.isReadOnly(TourEntity);
    const editHint = canEdit ? ` (${TourMessage.EditTour.niceToString()}: Ctrl/Alt+Click)` : "";
    const title = (hasViewed ? TourMessage.ReplayTour.niceToString() : TourMessage.StartTour.niceToString()) + editHint;

    function handleClickOrEdit(e: React.MouseEvent): void {
        if (canEdit && (e.ctrlKey || e.altKey)) {
            window.open(AppContext.toAbsoluteUrl(Navigator.navigateRoute(tour!.tour)));
            return;
        }
        if (!hasViewed) {
            localStorage.setItem(storageKey, "true");
            setHasViewed(true);
        }
        setTourRunId(prev => prev + 1);
    }

    return (
        <>
            <LinkButton className={classes("sf-pointer nav-link", p.className)} onClick={handleClickOrEdit} title={title}>
                <span className={classes("fa-layers fa-fw icon", !hasViewed && "fa-beat")}>
                    <FontAwesomeIcon aria-hidden={true} icon={faBiking} transform="flip-h" />
                    {canEdit && <FontAwesomeIcon aria-hidden={true} icon={["fas", "circle-arrow-right"]} transform="shrink-7 down-4 left-6" color="var(--bs-info)" />}
                </span>
            </LinkButton>
            {tourRunId > 0 && <TourComponent key={tourRunId} tour={tour} autoStart={true} />}
        </>
    );
}

function CreateTourButton(p: { trigger: PseudoType | Symbol | Lite<Entity>; className?: string }): React.JSX.Element | null {

    if (!Navigator.isCreable(TourEntity, { isSearch: true }))
        return null;

    async function handleCreate(): Promise<void> {
        const triggerLite = await resolveTriggerLite(p.trigger);
        if (triggerLite == null)
            return;
        await Navigator.createInNewTab({ entity: TourEntity.create({ trigger: triggerLite }), canExecute: {} });
    }

    return (
        <LinkButton className={classes("sf-pointer nav-link", p.className)}
            onClick={() => void handleCreate()}
            title={TourMessage.CreateTour.niceToString()}>
            <span className="fa-layers fa-fw icon">
                <FontAwesomeIcon aria-hidden={true} icon={faBiking} transform="flip-h" color="var(--bs-secondary)" />
                <FontAwesomeIcon aria-hidden={true} icon={["fas", "circle-plus"]} transform="shrink-7 down-4 left-6" color="var(--bs-success)" />
            </span>
        </LinkButton>
    );
}

// A PseudoType trigger has to become the TypeEntity LITE the tour stores; the other two already are one.
async function resolveTriggerLite(trigger: PseudoType | Symbol | Lite<Entity>): Promise<Lite<Entity> | null> {
    if (trigger instanceof Lite)
        return trigger;
    if (trigger instanceof Symbol)
        return trigger.toLite();
    return await TourClient.API.typeLite(getTypeName(trigger as PseudoType));
}

/**
 * Signum's `waitForElement`: a step may CLICK its own target (a tab, a dropdown) to reveal what the next
 * step points at, so the player has to wait for the DOM to catch up before moving on.
 */
function waitForElement(selector: string, timeout: number = 5000): Promise<Element> {
    return new Promise((resolve, reject) => {
        const found = document.querySelector(selector);
        if (found != null)
            return resolve(found);

        const observer = new MutationObserver(() => {
            const el = document.querySelector(selector);
            if (el != null) {
                observer.disconnect();
                resolve(el);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        setTimeout(() => {
            observer.disconnect();
            reject(new Error("Element not found: " + selector));
        }, timeout);
    });
}

/** The driver.js player itself. Renders nothing — it drives the page. */
export function TourComponent({ tour, autoStart = true }: { tour: TourDTO; autoStart?: boolean }): null {

    React.useEffect(() => {
        if (tour == null)
            return;

        const steps = tour.steps.map<DriveStep>((step, i, all) => ({
            element: step.cssSelector ?? undefined,
            popover: step.cssSelector ? {
                title: step.title ?? undefined,
                // The step's description is authored as MARKDOWN (Signum edits it with a MarkdownLine).
                description: step.description ? micromark(step.description) : undefined,
                side: (step.side ?? undefined) as Side | undefined,
                align: (step.align ?? undefined) as Alignment | undefined,
                onPopoverRender: async () => {
                    if (step.click === "OnLoad" && step.cssSelector) {
                        const elem = await waitForElement(step.cssSelector);
                        (elem as HTMLElement).click();
                    }
                },
                onNextClick: async e => {
                    if (step.click === "OnNext") {
                        (e as HTMLElement).click();
                        const nextSelector = all[i + 1]?.cssSelector;
                        if (nextSelector)
                            await waitForElement(nextSelector);
                    }
                    driverObj.moveNext();
                },
            } : {
                title: step.title ?? undefined,
                description: step.description ? micromark(step.description) : undefined,
            },
        }));

        const driverObj: Driver = driver({
            steps,
            showProgress: tour.showProgress,
            animate: tour.animate,
            showButtons: ["next", "previous", tour.showCloseButton ? "close" : null].filter(Boolean) as never,

            nextBtnText: TourMessage.Next.niceToString(),
            prevBtnText: TourMessage.Previous.niceToString(),
            doneBtnText: TourMessage.Done.niceToString(),

            overlayColor: "black",
            overlayOpacity: 0.3,
            stagePadding: 10,
            stageRadius: 5,
            popoverOffset: 10,
            allowClose: true,
        });

        if (autoStart)
            driverObj.drive();

        return () => { driverObj.destroy(); };
    }, [tour, autoStart]);

    return null;
}

export default TourComponent;
