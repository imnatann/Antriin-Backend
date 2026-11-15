import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
// Importing the plugin types also loads its FastifyRequest augmentation, which
// is what makes request.file() typed here.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {} from '@fastify/multipart';
import { createReadStream } from 'node:fs';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { MediaService } from './media.service';
import { MEDIA_MODERATION_STATUSES } from './media.constants';
import { UploadMediaQueryDto } from './dto/media.dto';

const mediaAssetSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    purpose: { type: 'string' },
    url: { type: 'string', example: '/api/v1/media/0b6f...' },
    contentType: {
      type: 'string',
      enum: ['image/jpeg', 'image/png', 'image/webp'],
    },
    byteSize: { type: 'integer', minimum: 1 },
    width: { type: 'integer', nullable: true },
    height: { type: 'integer', nullable: true },
    checksumSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    originalFilename: { type: 'string' },
    metadataStripped: {
      type: 'boolean',
      description:
        'True when embedded metadata (EXIF/XMP/IPTC/comments) was removed before the bytes were stored, so the stored size and checksum differ from the upload.',
    },
    moderationStatus: {
      type: 'string',
      enum: [...MEDIA_MODERATION_STATUSES],
      description:
        'Review state. Read-only: no scanner is integrated, so uploads stay unreviewed.',
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'id',
    'purpose',
    'url',
    'contentType',
    'byteSize',
    'width',
    'height',
    'checksumSha256',
    'originalFilename',
    'metadataStripped',
    'moderationStatus',
    'createdAt',
  ],
};

const createdResponse = {
  type: 'object',
  properties: { data: mediaAssetSchema },
  required: ['data'],
};

const limitsResponse = {
  type: 'object',
  properties: {
    data: {
      type: 'object',
      properties: {
        maxBytes: { type: 'integer' },
        contentTypes: { type: 'array', items: { type: 'string' } },
        purposes: { type: 'array', items: { type: 'string' } },
      },
      required: ['maxBytes', 'contentTypes', 'purposes'],
    },
  },
  required: ['data'],
};

/**
 * Image upload and delivery.
 *
 * Upload requires a bearer token because every asset records its owner; reading
 * does not, because the only reason to store a picture is to show it to buyers
 * on a menu or a profile. The stored key is never exposed and never supplied by
 * a client, so knowing an id is the only way to reach a file.
 */
@ApiTags('Media')
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get('limits')
  @ApiOperation({
    summary: 'Advertised upload limits (max size, accepted types, purposes)',
    description:
      'Lets a client reject an oversized or unsupported file before spending a request on it. No bearer token is required.',
  })
  @ApiOkResponse({ description: 'Upload limits', schema: limitsResponse })
  limits() {
    return { data: this.media.limits };
  }

  @Post()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload one image',
    description:
      'Accepts a single multipart file part named "file" with purpose given as a query parameter. The content type is verified against the file header, not trusted from the client; only JPEG, PNG and WebP up to the advertised size are stored. Embedded metadata (EXIF/GPS, XMP, IPTC, comments) is removed before the bytes are written, so the stored size and checksum describe the stripped file; metadataStripped reports whether anything was removed. The response url can be used directly as a menu item imageRef. Moderation state is reported (moderationStatus) but there is no endpoint to change it.',
  })
  @ApiCreatedResponse({ description: 'Stored asset', schema: createdResponse })
  @ApiBadRequestResponse({
    description:
      'Missing file (MEDIA_FILE_REQUIRED) or empty file (MEDIA_EMPTY_FILE)',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @ApiUnsupportedMediaTypeResponse({
    description:
      'Type not allowed (MEDIA_TYPE_NOT_ALLOWED), unrecognised content (MEDIA_CONTENT_UNRECOGNISED) or declared/content mismatch (MEDIA_TYPE_MISMATCH)',
  })
  @ApiPayloadTooLargeResponse({
    description: 'File exceeds the advertised maxBytes (MEDIA_FILE_TOO_LARGE)',
  })
  async upload(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query() query: UploadMediaQueryDto,
    @Req() request: FastifyRequest,
  ) {
    // @fastify/multipart returns the first file part whatever its name, so the
    // documented field name is enforced here rather than assumed.
    const file = await request.file();
    if (!file || file.fieldname !== 'file') {
      throw new BadRequestException({
        code: 'MEDIA_FILE_REQUIRED',
        message: 'A multipart file part named "file" is required',
      });
    }
    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch (error) {
      // @fastify/multipart aborts the part as soon as the size limit is passed.
      if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new PayloadTooLargeException({
          code: 'MEDIA_FILE_TOO_LARGE',
          message: `The uploaded file exceeds the ${this.media.limits.maxBytes} byte limit`,
        });
      }
      throw error;
    }
    const asset = await this.media.create(user.userId, query.purpose, {
      buffer,
      declaredContentType: file.mimetype,
      filename: file.filename,
    });
    return { data: this.render(asset) };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Download a stored image',
    description:
      'Streams the stored bytes with their real content type. The response is immutable and carries an ETag derived from the file checksum, so a repeat request with If-None-Match gets 304. Deleted assets return 404. No bearer token is required.',
  })
  @ApiOkResponse({ description: 'The image bytes' })
  @ApiNotFoundResponse({
    description: 'Unknown or deleted asset (MEDIA_NOT_FOUND)',
  })
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const asset = await this.media.findById(id);
    if (!asset || !(await this.media.exists(asset)))
      throw this.media.notFound();

    const etag = `"${asset.checksumSha256}"`;
    reply
      .header('content-type', asset.contentType)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('etag', etag)
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'inline');
    if (request.headers['if-none-match'] === etag) {
      reply.status(304).send();
      return;
    }
    reply.header('content-length', String(asset.byteSize));
    reply.send(createReadStream(this.media.resolvePath(asset.storageKey)));
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete one of your own images',
    description:
      "Soft delete: the asset stops being served immediately and the row is kept as a tombstone. Another user's asset returns 404 rather than 403 so the endpoint cannot be used to probe for existence.",
  })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @ApiNotFoundResponse({
    description:
      'Unknown, already deleted, or not owned by you (MEDIA_NOT_FOUND)',
  })
  async remove(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.media.remove(user.userId, id);
  }

  private render(asset: {
    id: string;
    purpose: string;
    contentType: string;
    byteSize: number;
    width: number | null;
    height: number | null;
    checksumSha256: string;
    originalFilename: string;
    metadataStripped: boolean;
    moderationStatus: string;
    createdAt: string;
  }) {
    return {
      id: asset.id,
      purpose: asset.purpose,
      url: `/api/v1/media/${asset.id}`,
      contentType: asset.contentType,
      byteSize: asset.byteSize,
      width: asset.width,
      height: asset.height,
      checksumSha256: asset.checksumSha256,
      originalFilename: asset.originalFilename,
      metadataStripped: asset.metadataStripped,
      // Read-only: served so a client can see that nothing has reviewed the
      // image. No endpoint writes it.
      moderationStatus: asset.moderationStatus,
      createdAt: asset.createdAt,
    };
  }
}
