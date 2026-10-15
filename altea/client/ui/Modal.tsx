import * as React from "react";
import { Dialog } from "radix-ui";
import { CloseButton } from "./Alert";
import { cn } from "./utils";

/** `xs` is altea's BsSize; a modal treats it as `sm`. */
export type ModalSize = "xs" | "sm" | "md" | "lg" | "xl" | "fullscreen";

/** Long enough for the close animation; `onExited` waits for it. */
const EXIT_DURATION = 160;

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

function ModalRoot(p: ModalProps): React.ReactElement | null {
    const [open, setOpen] = React.useState(p.show);
    const returnFocus = React.useRef<HTMLElement | null>(null);
    const contentRef = React.useRef<HTMLDivElement>(null);
    const wasShown = React.useRef(false);
    // Read during render: by the time an effect runs, Radix has already moved the focus into the dialog.
    if (p.show && !wasShown.current)
        returnFocus.current = document.activeElement as HTMLElement | null;
    wasShown.current = p.show;
    const onExited = React.useRef(p.onExited);
    onExited.current = p.onExited;

    React.useEffect(() => {
        if (p.show) {
            setOpen(true);
            return;
        }
        if (!open)
            return;
        setOpen(false);
        const timer = window.setTimeout(() => onExited.current?.(), EXIT_DURATION);
        return () => window.clearTimeout(timer);
    }, [p.show]);

    const isStatic = p.backdrop === "static";
    const size = p.size ?? "md";

    return (
        <ModalContext.Provider value={{ onHide: p.onHide }}>
            <Dialog.Root open={open} modal={p.enforceFocus !== false} onOpenChange={o => { if (!o) p.onHide?.(); }}>
                <Dialog.Portal>
                    {p.backdrop !== false &&
                        <Dialog.Overlay className="sf-modal-backdrop fixed inset-0 z-[1055] bg-black/50 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out motion-reduce:animate-none" />}
                    <Dialog.Content
                        {...(p["aria-labelledby"] ? { "aria-labelledby": p["aria-labelledby"] } : {})}
                        aria-describedby={p["aria-describedby"]}
                        onEscapeKeyDown={e => { if (p.keyboard === false) e.preventDefault(); }}
                        ref={contentRef}
                        onOpenAutoFocus={e => {
                            // react-bootstrap's behaviour: the dialog itself takes the focus, unless a control in it
                            // already did (an autoFocus input).
                            e.preventDefault();
                            if (!contentRef.current?.contains(document.activeElement))
                                contentRef.current?.focus();
                        }}
                        onCloseAutoFocus={e => {
                            // Opened from code, not from a Radix Trigger: give the focus back to whatever had it.
                            e.preventDefault();
                            if (returnFocus.current?.isConnected)
                                returnFocus.current.focus();
                        }}
                        onPointerDownOutside={e => e.preventDefault()}
                        onInteractOutside={e => e.preventDefault()}
                        onMouseDown={e => { if (e.target === e.currentTarget && !isStatic) p.onHide?.(); }}
                        className={cn("sf-modal fixed inset-0 z-[1055] overflow-x-hidden overflow-y-auto outline-none",
                            "data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none", p.className)}>
                        <div className={cn("sf-modal-dialog pointer-events-none relative mx-2 my-2 w-auto sm:mx-auto sm:my-7", "sf-modal-" + size, dialogSizes[size], p.dialogClassName)}>
                            <div className={cn("sf-modal-content", size === "fullscreen" && "h-full rounded-none border-0", p.contentClassName)}>
                                {p.children}
                            </div>
                        </div>
                    </Dialog.Content>
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
