import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class ProvisionTenantOwnerDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Existing active user who becomes the first verified owner',
  })
  @IsUUID()
  subjectUserId!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    description:
      'Provisioning reason recorded in the immutable audit and access-audit trails',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
