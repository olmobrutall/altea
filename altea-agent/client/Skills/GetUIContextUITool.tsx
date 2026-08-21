import { GlobalModalContainer } from "@altea/altea/client/Modals";
import type { ChatMessageEntity_ToolCall } from "../../data/ChatSession";
import { UITool } from "../ChatbotClient";

// Port of Signum.Agent's Skills/GetUIContextUITool.tsx — the browser half of the server's `GetUIContext` UI
// tool. It shows NOTHING: `handleDirectly` reads the browser state and answers immediately, so the agent loop
// resumes on the next request. `GlobalModalContainer.getPageUIState()` / `getModalUIStates()` are altea's own
// (a page registers its state with `usePageUIState`), same as Signum's.
export class GetUIContextUITool extends UITool {
    uiToolName = "GetUIContext";

    override async handleDirectly(call: ChatMessageEntity_ToolCall,
        sendToolResponse: (call: ChatMessageEntity_ToolCall, response: unknown) => void): Promise<void> {

        sendToolResponse(call, {
            url: window.location.href,
            language: navigator.language,
            screenWidth: window.screen.width,
            screenHeight: window.screen.height,
            pageUIState: GlobalModalContainer.getPageUIState(),
            modalUIStates: GlobalModalContainer.getModalUIStates(),
        });
    }
}
