import { SkillCode, Schema as S } from "../SkillCode";

// Port of Signum.Agent's Skills/IntroductionSkill.cs — the ROOT skill: it introduces the application and
// owns the two discovery tools every lazy sub-skill depends on.
//
// altea divergences:
//  - `<CurrentApplication>` came from `Assembly.GetEntryAssembly().GetName().Name.Before(".")`. Node has no
//    entry assembly, so it is `applicationName` — settable by the host (eastwind sets it in its Starter),
//    defaulting to the `npm_package_name` the process was started with.
export class IntroductionSkill extends SkillCode {

    /** Signum's `<CurrentApplication>` replacement source. */
    static applicationName: string = (process.env["npm_package_name"] ?? "the application").split(".")[0]!;

    constructor() {
        super();

        this.shortDescription = "Introduction to the application's Chatbot";
        this.isAllowed = () => true;
        this.replacements = {
            "<CurrentApplication>": () => IntroductionSkill.applicationName,
        };

        this.registerTool({
            name: "Describe",
            description: "Gets the instructions for a skill and discovers its tools",
            returnType: "string",
            parameters: S.args({ skillName: S.string() }),
            invoke: async args => {
                const skillName = String(args["skillName"]);
                const skill = this.findSkill(skillName);
                if (skill == undefined)
                    throw new Error(`Skill '${skillName}' not found`);
                return skill.getInstruction(null);
            },
        });

        this.registerTool({
            name: "ListSkillNames",
            description: "List available skills with a short description, start here to discover new tools.",
            returnType: "Dictionary<string, string>",
            parameters: S.args({}),
            invoke: async () => Object.fromEntries([...this.getSkillsRecursive()].map(s => [s.name, s.shortDescription])),
        });
    }
}

/** The tool name the agent loop and the MCP server watch for, to unlock a lazy skill's tools. */
export const describeToolName = "Describe";
