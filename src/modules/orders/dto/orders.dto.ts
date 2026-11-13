import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  MAX_CHECKOUT_LINES,
  MAX_ITEM_NOTES_LENGTH,
  MAX_LINE_OPTIONS,
  MAX_LINE_QUANTITY,
  MAX_SPECIAL_REQUEST_LENGTH,
  ORDER_PAGE_LIMIT_MAX,
  ORDER_STATUSES,
} from '../orders.constants';
import type { OrderStatus } from '../orders.constants';

/**
 * Checkout input. The server never accepts price, total, currency or status
 * from the client: they are recomputed from the catalog snapshot
 * (CatalogService.quote) and the wallet ledger inside the checkout
 * transaction.
 */
export class CheckoutItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  menuItemId!: string;

  @ApiProperty({
    minimum: 1,
    maximum: MAX_LINE_QUANTITY,
    description:
      'Pilot operational bound (DB allows 1..999 so product can widen this without a migration).',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description:
      'Selected option choices for this line (snapshot at checkout).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LINE_OPTIONS)
  @IsUUID('all', { each: true })
  optionIds?: string[];

  @ApiPropertyOptional({ maxLength: MAX_ITEM_NOTES_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ITEM_NOTES_LENGTH)
  notes?: string;
}

export class CheckoutDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  slotId!: string;

  @ApiProperty({
    minimum: 1,
    description:
      'pickup_slots.version from the quote. Stale after a capacity/status management change -> 409.',
  })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expectedSlotVersion!: number;

  @ApiProperty({ type: [CheckoutItemDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CHECKOUT_LINES)
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  items!: CheckoutItemDto[];

  @ApiPropertyOptional({
    maxLength: MAX_SPECIAL_REQUEST_LENGTH,
    description: 'Order-level note shown to the tenant kitchen.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SPECIAL_REQUEST_LENGTH)
  specialRequest?: string;
}

/** Buyer order list filters (cursor pagination, wallet slice pattern). */
export class BuyerOrderListQueryDto {
  @ApiPropertyOptional({ enum: ORDER_STATUSES })
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: OrderStatus;

  @ApiPropertyOptional({
    description: 'Opaque cursor from meta.next_cursor of the previous page.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,512}$/)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: ORDER_PAGE_LIMIT_MAX })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ORDER_PAGE_LIMIT_MAX)
  limit?: number;
}

/** Tenant order queue filters; requires tenant.orders.read. */
export class TenantOrderListQueryDto extends BuyerOrderListQueryDto {}

/**
 * Tenant transition input. `reason` is mandatory for decline (audit + event),
 * optional otherwise. `expectedStatus` is an extra optimistic guard: a mismatch
 * means the caller acted on a stale queue row -> 409.
 */
export class TenantOrderTransitionDto {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 500,
    description:
      'Mandatory when declining (recorded in order_events + immutable audit).',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({ enum: ORDER_STATUSES })
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  expectedStatus?: OrderStatus;
}

export class DeclineOrderDto {
  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ enum: ORDER_STATUSES })
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  expectedStatus?: OrderStatus;
}

export class CreateScheduleProposalDto {
  @ApiProperty({
    format: 'uuid',
    description: 'New pickup slot proposed by the tenant (same tenant only).',
  })
  @IsUUID()
  proposedSlotId!: string;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class DecideScheduleProposalDto {
  @ApiProperty({ enum: ['accept', 'reject'] })
  @IsIn(['accept', 'reject'])
  decision!: 'accept' | 'reject';
}
