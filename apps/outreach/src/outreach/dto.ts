import { IsOptional, IsUUID } from 'class-validator';

export class RunOutreachDto {
  @IsOptional()
  @IsUUID()
  opportunityId?: string;

  @IsOptional()
  @IsUUID()
  personId?: string;
}
