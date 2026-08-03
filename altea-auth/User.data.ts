import { field } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";

export class UserEntity extends Entity {
    @field name: string;
    @field email: string;
    @field passwordHash: string;
}
