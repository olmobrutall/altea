import { SkillCode } from "../SkillCode";

// Port of Signum.Agent's Skills/ConversationSumarizerSkill.cs — a prompt-only skill (no tools): it turns a
// transcript into a summary so the conversation can outlive the context window.
export class ConversationSumarizerSkill extends SkillCode {
    constructor() {
        super();

        this.shortDescription = "Summarizes conversation history for context window management";
        this.isAllowed = () => true;
        this.replacements = {
            "$<ConversationToSummarize>": context => String(context ?? ""),
        };
    }
}
