import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faComments } from "@fortawesome/free-solid-svg-icons";
import { ErrorBoundary } from "@altea/altea/client/Components";
import "./ChatButton.css";

const ChatbotModal = React.lazy(() => import("./ChatbotModal"));

// Port of Signum.Agent's ChatbotButton.tsx — the floating button that opens the chat panel. The app renders
// it from its Layout (Southwind lazy-imports it there, as eastwind does).
export default function ChatbotButton(): React.ReactElement {
    const [showModal, setShowModal] = React.useState(false);

    return (
        <>
            {!showModal && <button type="button"
                className="btn btn-primary chat-button shadow-lg rounded-circle"
                onClick={() => setShowModal(true)}
                aria-label="Chat">
                <FontAwesomeIcon icon={faComments} size="lg" />
            </button>}
            {showModal && (
                <ErrorBoundary>
                    <React.Suspense fallback={null}>
                        <ChatbotModal onClose={() => setShowModal(false)} />
                    </React.Suspense>
                </ErrorBoundary>
            )}
        </>
    );
}
