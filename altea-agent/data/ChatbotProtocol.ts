import type { SkillActivationEnum } from "./SkillCustomization";
import type { UserFeedbackEnum } from "./ChatSession";

// The wire contracts of Signum.Agent's two HTTP surfaces, declared ONCE in the DATA layer so the server
// that writes them and the client that parses them cannot drift. In Signum these live in three places:
// the `[InTypeScript] enum ChatbotUICommand` in ChatbotController.cs, the `DefaultSkillCodeInfo` family in
// SkillCodeLogic.cs (server), and hand-written duplicates of them in AgentClient.tsx (client).

// ---- the streaming chat protocol (Signum's ChatbotUICommand) ----------------------------------------
//
// `POST /api/chatbot/ask` answers with a `text/plain` STREAM, not JSON: the answer is echoed token by
// token as the model produces it. Control lines are `$!<Command>` or `$!<Command>:<payload>` on their own
// line (so a payload may not contain a newline); everything else is content for whatever the last command
// opened. Kept verbatim from Signum, because the framing is the contract.
export const chatbotUICommands = [
    "System",
    "SessionId",
    "SessionTitle",
    "QuestionId",
    "MessageId",
    "AssistantStarted",
    "AssistantAnswer",
    "AssistantReasoning",
    "AssistantTool",
    "AssistantUITool",
    "Tool",
    "Exception",
] as const;

export type ChatbotUICommand = typeof chatbotUICommands[number];

/**
 * Signum's `AssistantMode` — which of an assistant turn's two streams the following content belongs to.
 * A union rather than an altea enum object: it never reaches a database column, only the stream framing.
 */
export type AssistantMode = "Text" | "Reasoning";

/** The body of `POST /api/chatbot/feedback/:messageId` (Signum's SetFeedbackRequest). */
export interface SetFeedbackRequest {
    feedback: UserFeedbackEnum | null;
    message?: string;
}

// ---- skill introspection (Signum's DefaultSkillCodeInfo family) -------------------------------------
//
// What `GET /api/agentSkill/skillCodeInfo/:name` returns: everything the SkillCode / Agent editors need to
// show what a skill does BY DEFAULT — so a customization can be diffed against it.

export interface SkillCodeInfo {
    defaultShortDescription: string;
    defaultInstructions: string;
    properties: SkillPropertyMeta[];
    tools: ToolInfo[];
    subSkills: SubSkillInfo[];
}

export interface SkillPropertyMeta {
    propertyName: string;
    /**
     * Which editor the client should use for the value (`AgentClient.registerPropertyValueControl`).
     * Signum derives it from the C# attribute CLASS name (`SkillProperty_QueryList` →
     * "SkillProperty_QueryList"); altea's skills name their property kind explicitly, since TypeScript
     * cannot reflect property attributes — see server/SkillCode.ts.
     */
    attributeName: string;
    valueHint: string | null;
    propertyType: string;
    defaultValue: string | null;
}

export interface ToolInfo {
    /** The name the model calls the tool by. */
    mcpName: string;
    description: string | null;
    returnType: string;
    parameters: ToolParameter[];
}

export interface ToolParameter {
    name: string;
    type: string;
    isRequired: boolean;
    description: string | null;
}

export interface SubSkillInfo {
    className: string;
    activation: SkillActivationEnum;
    info: SkillCodeInfo;
}
