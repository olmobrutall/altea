import { ChatMessageRoleEnum } from "../../data/ChatSession";
import { SkillCode } from "../SkillCode";
import type { ConversationHistory } from "../ChatbotLogic";

// Port of Signum.Agent's Skills/QuestionSumarizerSkill.cs — a prompt-only skill that titles a session from
// its user questions. altea divergences: it reads the stored messages directly instead of round-tripping
// them through `history.GetMessages()` (the provider-facing shape carries nothing extra here), and
// Signum's `Etc(500)` ellipsis helper is spelled out.
export class QuestionSumarizerSkill extends SkillCode {
    constructor() {
        super();

        this.shortDescription = "Summarizes the user's questions in the conversation";
        this.isAllowed = () => true;
        this.replacements = {
            "$<Conversation>": context => {
                const history = context as ConversationHistory | null;
                if (history == null)
                    return "";

                const text = history.messages
                    .filter(m => m.role === ChatMessageRoleEnum.User)
                    .map((m, i) => `Question ${i + 1}:\n${m.content ?? ""}`)
                    .join("\n\n");

                return text.length <= 500 ? text : `${text.slice(0, 500)}...`;
            },
        };
    }
}
