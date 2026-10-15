import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import { CloseButton } from "./Alert";
import { cn } from "./utils";

/** `xs` is altea's BsSize; a modal treats it as `sm`. */
export type ModalSize = "xs" | "sm" | "md" | "lg" | "xl" | "fullscreen";

const dialogSizes: Record<ModalSize, string> = {
    xs: "sm:max-w-[300px]",
    sm: "sm:max-w-[300px]",
    md: "sm:max-w-[500px]",
    lg: "sm:max-w-[500px] lg:max-w-[800px]",
    xl: "sm:max-w-[500px] lg:max-w-[800px] xl:max-w-[1140px]",
    fullscreen: "m-0 h-full w-screen max-w-none p-0",
};

export interface ModalProps {
    show: boolean;
    /** The user asked to close it (Escape, the backdrop, the header's close button). */
    onHide?: () => void;
    /** The close animation finished — altea's `openModal` resolves its promise here. */
    onExited?: () => void;
    size?: ModalSize;
    /** `"static"`: clicking the backdrop does not close it. */
    backdrop?: boolean | "static";
    /** Escape closes it (default true). */
    keyboard?: boolean;
    /** Keep the focus inside while open (default true). */
    enforceFocus?: boolean;
    className?: string;
    dialogClassName?: string;
    contentClassName?: string;
    "aria-labelledby"?: string;
    "aria-describedby"?: string;
    children?: React.ReactNode;
}

const ModalContext = React.createContext<{ onHide?: () => void }>({});

/** The open modals, innermost last: Escape and the backdrop act on the top one only. altea opens modals as
 * SIBLINGS (openModal), so Base UI does not see them as nested. */
const openModals: object[] = [];

function ModalRoot(p: ModalProps): React.ReactElement | null {
    const returnFocus = React.useRef<HTMLElement | null>(null);
    const popupRef = React.useRef<HTMLDivElement>(null);
    const wasShown = React.useRef(false);
    const token = React.useRef({}).current;
    // Read during render: by the first effect the focus has already moved into the dialog.
    if (p.show && !wasShown.current)
        returnFocus.current = document.activeElement as HTMLElement | null;
    wasShown.current = p.show;

    React.useEffect(() => {
        if (!p.show)
            return;
        openModals.push(token);
        return () => { openModals.splice(openModals.indexOf(token), 1); };
    }, [p.show]);

    const isStatic = p.backdrop === "static";
    const size = p.size ?? "md";

    function handleOpenChange(open: boolean, details: Dialog.Root.ChangeEventDetails): void {
        if (open)
            return;
        const isTop = openModals[openModals.length - 1] === token;
        if (details.reason === "escape-key" && (p.keyboard === false || !isTop))
            return;
        if (details.reason === "outside-press" && (isStatic || !isTop))
            return;
        if (details.reason === "focus-out")
            return;
        p.onHide?.();
    }

    return (
        <ModalContext.Provider value={{ onHide: p.onHide }}>
            <Dialog.Root open={p.show} modal={p.enforceFocus !== false} onOpenChange={handleOpenChange}
                onOpenChangeComplete={open => { if (!open) p.onExited?.(); }}>
                <Dialog.Portal>
                    {p.backdrop !== false &&
                        <Dialog.Backdrop forceRender className="sf-modal-backdrop fixed inset-0 z-[1055] bg-black/50 data-[open]:animate-fade-in data-[closed]:animate-fade-out motion-reduce:animate-none" />}
                    <Dialog.Viewport className={cn("sf-modal fixed inset-0 z-[1055] overflow-x-hidden overflow-y-auto outline-none", p.className)}>
                        <Dialog.Popup ref={popupRef}
                            {...(p["aria-labelledby"] ? { "aria-labelledby": p["aria-labelledby"] } : {})}
                            aria-describedby={p["aria-describedby"]}
                            // react-bootstrap's behaviour: the dialog itself takes the focus, unless a control in it
                            // already did (an autoFocus input); on close, the element that had it before gets it back.
                            initialFocus={() => popupRef.current?.contains(document.activeElement) ? false : popupRef.current}
                            finalFocus={() => returnFocus.current?.isConnected ? returnFocus.current : true}
                            className={cn("sf-modal-dialog relative mx-2 my-2 w-auto outline-none sm:mx-auto sm:my-7", "sf-modal-" + size, dialogSizes[size],
                                "data-[open]:animate-modal-in data-[closed]:animate-modal-out motion-reduce:animate-none", p.dialogClassName)}>
                            <div className={cn("sf-modal-content", size === "fullscreen" && "h-full rounded-none border-0", p.contentClassName)}>
                                {p.children}
                            </div>
                        </Dialog.Popup>
                    </Dialog.Viewport>
                </Dialog.Portal>
            </Dialog.Root>
        </ModalContext.Provider>
    );
}

export interface ModalHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
    /** Adds the × that calls the modal's `onHide`. */
    closeButton?: boolean;
}

function ModalHeader({ className, closeButton, children, ...props }: ModalHeaderProps): React.ReactElement {
    const { onHide } = React.useContext(ModalContext);
    return (
        <div className={cn("sf-modal-header gap-2", className)} {...props}>
            {children}
            {closeButton && <CloseButton onClick={onHide} />}
        </div>
    );
}

function ModalTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>): React.ReactElement {
    return <Dialog.Title className={cn("sf-modal-title text-h5 font-medium leading-normal", className)} {...props} />;
}

function ModalBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
    return <div className={cn("sf-modal-body", className)} {...props} />;
}

function ModalFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
    return <div className={cn("sf-modal-footer", className)} {...props} />;
}

export interface ModalComponent {
    (p: ModalProps): React.ReactElement | null;
    Header: typeof ModalHeader;
    Title: typeof ModalTitle;
    Body: typeof ModalBody;
    Footer: typeof ModalFooter;
}

/**
 * A dialog with react-bootstrap's `Modal` shape (`show` / `onHide` / `onExited` / `size` / `Modal.Header` …),
 * so the modals altea opens through `openModal` move over without restructuring.
 */
export const Modal: ModalComponent = Object.assign(ModalRoot, { Header: ModalHeader, Title: ModalTitle, Body: ModalBody, Footer: ModalFooter });
