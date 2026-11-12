import { Type } from 'class-transformer';
import {
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class WalletBalanceQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['IDR'])
  currency?: string;
}

export class WalletTransactionsQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['IDR'])
  currency?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,512}$/)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
