import { field } from "@altea/altea/entities/reflection";
import { Entity } from "@altea/altea/entities/entity";

export class UserEntity extends Entity {
    @field name: string;
    @field email: string;
    @field passwordHash: string;
}
