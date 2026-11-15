import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { MEDIA_PURPOSES, type MediaPurpose } from '../media.constants';

/**
 * `purpose` travels as a query parameter rather than a multipart field so the
 * global ValidationPipe validates it declaratively; the request body carries
 * only the file part.
 */
export class UploadMediaQueryDto {
  @ApiProperty({
    enum: MEDIA_PURPOSES,
    description:
      'What the file is for. Recorded on the asset; it does not grant permission to attach it anywhere.',
  })
  @IsIn(MEDIA_PURPOSES)
  purpose!: MediaPurpose;
}
