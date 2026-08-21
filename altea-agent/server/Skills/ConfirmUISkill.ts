import { SkillCode, Schema as S } from "../SkillCode";

// Port of Signum.Agent's Skills/ConfirmUISkill.cs — a UI TOOL: the server never runs it. The controller
// streams the call to the browser, the widget renders buttons, and the user's answer arrives as the tool
// result in the next request (see client/Skills/ConfirmUITool.tsx).
//
// altea divergence: Signum marks the method `[UITool]` and gives it a body that throws; here the tool is
// simply declared `isUITool: true` with no `invoke`, which SkillCode.registerTool enforces.
export class ConfirmUISkill extends SkillCode {
    constructor() {
        super();

        this.shortDescription = "Asks the user for confirmation or a choice before proceeding with a sensitive action";
        this.isAllowed = () => true;

        this.registerTool({
            name: "Confirm",
            isUITool: true,
            description: "Shows an inline confirmation dialog in the chat with a title, message and a set of buttons. "
                + "Returns the label of the button the user clicked. "
                + "Use this before any destructive or irreversible action to get explicit user approval.",
            returnType: "string",
            parameters: S.args({
                title: S.string('Short title for the confirmation, e.g. "Delete order"'),
                message: S.string("Full description of what the user is about to confirm"),
                buttons: S.array(S.string(), 'Labels for the buttons the user can click, e.g. ["Confirm", "Cancel"]'),
            }),
        });
    }
}
