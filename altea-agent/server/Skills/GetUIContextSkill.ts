import { SkillCode, Schema as S } from "../SkillCode";

// Port of Signum.Agent's Skills/GetUIContextSkill.cs — a UI TOOL (see ConfirmUISkill's header): it asks the
// BROWSER where the user is. Answered by client/Skills/GetUIContextUITool.tsx, which resolves it
// automatically (no widget, no user interaction).
export class GetUIContextSkill extends SkillCode {
    constructor() {
        super();

        this.shortDescription = "Retrieves context information from the user's browser (current URL, language, screen size)";
        this.isAllowed = () => true;

        this.registerTool({
            name: "GetUIContext",
            isUITool: true,
            description: "Requests the current browser context from the UI (URL, language, screen dimensions). "
                + "Call this at the start of tasks where knowing the user's current page or locale is relevant.",
            returnType: "object",
            parameters: S.args({}),
        });
    }
}
