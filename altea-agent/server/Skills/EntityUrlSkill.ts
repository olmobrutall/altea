import { SkillCode } from "../SkillCode";
import { CurrentServerContextSkill } from "./CurrentServerContextSkill";

// Port of Signum.Agent's Skills/EntityUrlSkill.cs — a prompt-only skill: how to build a `/view/Type/Id`
// link so the model's answers are clickable.
export class EntityUrlSkill extends SkillCode {
    constructor() {
        super();

        this.shortDescription = "Explains how to construct local URLs to navigate to entities in the application";
        this.isAllowed = () => true;
        this.replacements = {
            "<UrlLeft>": () => CurrentServerContextSkill.urlLeft?.() ?? "",
        };
    }
}
