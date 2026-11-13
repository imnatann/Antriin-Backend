import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ApiGuideService } from './api-guide.service';

/**
 * The API guide a frontend agent reads. Exposed only when SWAGGER_ENABLED is
 * true: the document is registered from bootstrap, and without it every route
 * here answers 404 like any other unknown path.
 */
@ApiExcludeController()
@Controller('guide')
export class ApiGuideController {
  constructor(private readonly guide: ApiGuideService) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  html(): string {
    return this.guide.renderHtml();
  }

  @Get('openapi.json')
  @Header('Cache-Control', 'no-store')
  document() {
    return this.guide.getDocument();
  }
}

/** Markdown twin of the HTML guide, at /guide.md next to it. */
@ApiExcludeController()
@Controller()
export class ApiGuideMarkdownController {
  constructor(private readonly guide: ApiGuideService) {}

  @Get('guide.md')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  markdown(): string {
    return this.guide.renderMarkdown();
  }
}
