import { Injectable, NotFoundException } from '@nestjs/common';
import type { OpenAPIObject, SchemaObject } from '@nestjs/swagger';
import {
  GUIDE_AUTH,
  GUIDE_CONVENTIONS,
  GUIDE_FLOWS,
  GUIDE_GAPS,
  GUIDE_INTRO,
  GUIDE_PERMISSIONS,
  type Block,
} from './api-guide.content';

const BT = String.fromCharCode(96);
const DL = String.fromCharCode(36);

type SchemaLike = SchemaObject & {
  $ref?: string;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  required?: string[];
  enum?: unknown[];
  nullable?: boolean;
  format?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  allOf?: SchemaObject[];
};

type Endpoint = {
  method: string;
  path: string;
  tag: string;
  summary: string;
  auth: boolean;
  parameters: {
    name: string;
    where: string;
    required: boolean;
    type: string;
    note: string;
  }[];
  requestBody: { required: boolean; schema: SchemaLike | undefined } | null;
  responses: {
    status: string;
    description: string;
    schema: SchemaLike | undefined;
  }[];
};

type ObjectView = {
  name: string;
  fields: { name: string; type: string; required: boolean; note: string }[];
};

function refName(schema: SchemaLike | undefined): string | undefined {
  const ref = schema?.$ref;
  return typeof ref === 'string' ? ref.split('/').pop() : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Serves the API guide a frontend agent reads. The endpoint and object
 * reference is generated from the live OpenAPI document, so it cannot drift
 * from the code; only the conventions prose is hand-written
 * (api-guide.content.ts).
 */
@Injectable()
export class ApiGuideService {
  private document: OpenAPIObject | undefined;

  /** Called once from bootstrap; without it the guide is not exposed. */
  setDocument(document: OpenAPIObject): void {
    this.document = document;
  }

  getDocument(): OpenAPIObject {
    if (!this.document) throw new NotFoundException('API guide is disabled');
    return this.document;
  }

  renderHtml(): string {
    const guide = this.build();
    const sections: string[] = [
      '<!doctype html><html lang="id"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>Antriin API Guide</title><style>',
      'body{font:15px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;margin:0;color:#111;background:#fafafa}',
      'main{max-width:1100px;margin:0 auto;padding:32px 24px 96px;background:#fff}',
      'h1{font-size:28px;margin:0 0 8px}h2{font-size:22px;margin:40px 0 12px;padding-top:12px;border-top:1px solid #e5e5e5}',
      'h3{font-size:17px;margin:24px 0 8px}h4{font-size:15px;margin:18px 0 6px}',
      'table{border-collapse:collapse;width:100%;margin:8px 0 16px;font-size:13px}',
      'th,td{border:1px solid #e0e0e0;padding:6px 8px;text-align:left;vertical-align:top}',
      'th{background:#f4f4f4;font-weight:600}code{background:#f2f2f2;padding:1px 4px;border-radius:3px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      'pre{background:#1e1e1e;color:#e6e6e6;padding:12px 14px;border-radius:6px;overflow-x:auto;font-size:12.5px}',
      'pre code{background:none;padding:0;color:inherit}',
      'nav{background:#f7f7f7;border:1px solid #e5e5e5;border-radius:6px;padding:12px 16px;font-size:13px}',
      'nav a{display:inline-block;margin:2px 10px 2px 0;color:#0b5fff;text-decoration:none}',
      '.method{display:inline-block;min-width:56px;font-weight:700;font-size:11px;letter-spacing:.04em}',
      '.get{color:#0a7d33}.post{color:#0b5fff}.patch{color:#a35a00}.put{color:#a35a00}.delete{color:#c00}',
      '.muted{color:#666}.auth{font-size:11px;color:#8a1f00;border:1px solid #e8c8c0;border-radius:3px;padding:0 4px}',
      'a{color:#0b5fff}</style></head><body><main>',
      '<h1>Antriin API Guide</h1>',
      '<p class="muted">Dibuat dari OpenAPI ' +
        escapeHtml(String(guide.version)) +
        ' · ' +
        String(guide.operationCount) +
        ' endpoint · ' +
        String(guide.objects.length) +
        ' object · sumber mesin: <a href="' +
        guide.base +
        '/guide/openapi.json">openapi.json</a> · <a href="' +
        guide.base +
        '/guide.md">Markdown</a></p>',
      '<nav><strong>Isi:</strong> ' +
        guide.tags
          .map(
            (tag, index) =>
              '<a href="#tag-' +
              String(index) +
              '">' +
              escapeHtml(tag) +
              '</a>',
          )
          .join('') +
        ' <a href="#objects">Objects</a></nav>',
    ];
    for (const block of guide.prose) sections.push(this.renderBlockHtml(block));
    sections.push('<h2 id="endpoints">6. Endpoint</h2>');
    guide.tags.forEach((tag, index) => {
      sections.push(
        '<h3 id="tag-' + String(index) + '">' + escapeHtml(tag) + '</h3>',
      );
      for (const endpoint of guide.endpoints.filter((item) => item.tag === tag))
        sections.push(this.renderEndpointHtml(endpoint));
    });
    sections.push('<h2 id="objects">7. Objects</h2>');
    for (const object of guide.objects)
      sections.push(this.renderObjectHtml(object));
    sections.push('</main></body></html>');
    return sections.join('\n');
  }

  renderMarkdown(): string {
    const guide = this.build();
    const out: string[] = ['# Antriin API Guide', ''];
    out.push(
      'Dibuat dari OpenAPI ' +
        String(guide.version) +
        ' · ' +
        String(guide.operationCount) +
        ' endpoint · ' +
        String(guide.objects.length) +
        ' object · sumber mesin: ' +
        guide.base +
        '/guide/openapi.json',
      '',
    );
    for (const block of guide.prose) out.push(this.renderBlockMarkdown(block));
    out.push('## 6. Endpoint', '');
    for (const tag of guide.tags) {
      out.push('### ' + tag, '');
      for (const endpoint of guide.endpoints.filter((item) => item.tag === tag))
        out.push(this.renderEndpointMarkdown(endpoint));
    }
    out.push('## 7. Objects', '');
    for (const object of guide.objects) {
      out.push('### ' + object.name, '');
      out.push(
        '| Field | Tipe | Wajib | Catatan |',
        '| --- | --- | --- | --- |',
      );
      for (const field of object.fields)
        out.push(
          '| ' +
            field.name +
            ' | ' +
            field.type.replaceAll('|', '\\|') +
            ' | ' +
            (field.required ? 'ya' : 'tidak') +
            ' | ' +
            field.note.replaceAll('|', '\\|') +
            ' |',
        );
      out.push('');
    }
    return out.join('\n');
  }

  // -------------------------------------------------------------------------
  // Model
  // -------------------------------------------------------------------------

  private build() {
    const document = this.getDocument();
    const endpoints: Endpoint[] = [];
    for (const [path, item] of Object.entries(document.paths ?? {}))
      for (const [method, operation] of Object.entries(
        item as Record<string, unknown>,
      )) {
        const op = operation as {
          tags?: string[];
          summary?: string;
          security?: unknown[];
          parameters?: {
            name: string;
            in: string;
            required?: boolean;
            description?: string;
            schema?: SchemaLike;
          }[];
          requestBody?: {
            required?: boolean;
            content?: Record<string, { schema?: SchemaLike }>;
          };
          responses?: Record<
            string,
            {
              description?: string;
              content?: Record<string, { schema?: SchemaLike }>;
            }
          >;
        };
        if (!op || typeof op !== 'object' || !('responses' in op)) continue;
        endpoints.push({
          method: method.toUpperCase(),
          path,
          tag: op.tags?.[0] ?? 'Lainnya',
          summary: op.summary ?? '',
          auth: Array.isArray(op.security) && op.security.length > 0,
          parameters: (op.parameters ?? []).map((parameter) => ({
            name: parameter.name,
            where: parameter.in,
            required: parameter.required === true,
            type: this.typeLabel(parameter.schema, document),
            note: parameter.description ?? '',
          })),
          requestBody: op.requestBody
            ? {
                required: op.requestBody.required === true,
                schema: op.requestBody.content?.['application/json']?.schema,
              }
            : null,
          responses: Object.entries(op.responses ?? {}).map(
            ([status, response]) => ({
              status,
              description: response?.description ?? '',
              schema: response?.content?.['application/json']?.schema,
            }),
          ),
        });
      }
    const tags = [...new Set(endpoints.map((item) => item.tag))];
    const objects: ObjectView[] = Object.entries(
      document.components?.schemas ?? {},
    )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, schema]) => ({
        name,
        fields: this.fieldRows(schema as SchemaLike, document),
      }));
    return {
      version: document.info?.version ?? '0.1.0',
      base: commonBasePath(endpoints.map((item) => item.path)),
      tags,
      endpoints,
      objects,
      operationCount: endpoints.length,
      prose: [
        ...GUIDE_INTRO,
        ...GUIDE_AUTH,
        ...GUIDE_CONVENTIONS,
        ...GUIDE_PERMISSIONS,
        ...GUIDE_FLOWS,
        ...GUIDE_GAPS,
      ],
    };
  }

  private fieldRows(
    schema: SchemaLike | undefined,
    document: OpenAPIObject,
  ): ObjectView['fields'] {
    const resolved = this.deref(schema, document);
    const properties = resolved?.properties ?? {};
    const required = new Set(resolved?.required ?? []);
    return Object.entries(properties).map(([name, property]) => ({
      name,
      type: this.typeLabel(property, document),
      required: required.has(name),
      note: this.note(property, document),
    }));
  }

  private deref(
    schema: SchemaLike | undefined,
    document: OpenAPIObject,
  ): SchemaLike | undefined {
    const name = refName(schema);
    if (!name) return schema;
    return (document.components?.schemas?.[name] as SchemaLike) ?? schema;
  }

  /** Short type label; a nested object is named so Objects stays the detail. */
  private typeLabel(
    schema: SchemaLike | undefined,
    document: OpenAPIObject,
  ): string {
    if (!schema) return 'any';
    const name = refName(schema);
    if (name) return name;
    let label: string;
    if (schema.type === 'array') {
      label = this.typeLabel(schema.items, document) + '[]';
    } else if (Array.isArray(schema.enum)) {
      label = schema.enum.map((value) => String(value)).join(' | ');
    } else if (schema.type === 'object' || schema.properties) {
      const keys = Object.keys(schema.properties ?? {});
      label = keys.length ? '{ ' + keys.join(', ') + ' }' : 'object';
    } else if (schema.type) {
      label = schema.format
        ? String(schema.type) + '(' + schema.format + ')'
        : String(schema.type);
    } else if (schema.oneOf || schema.anyOf) {
      label = (schema.oneOf ?? schema.anyOf ?? [])
        .map((item) => this.typeLabel(item, document))
        .join(' | ');
    } else {
      label = 'any';
    }
    return schema.nullable ? label + ' | null' : label;
  }

  /** Constraints and description rendered as one short note. */
  private note(
    schema: SchemaLike | undefined,
    document: OpenAPIObject,
  ): string {
    const resolved = this.deref(schema, document);
    if (!resolved) return '';
    const parts: string[] = [];
    if (Array.isArray(resolved.enum))
      parts.push('enum: ' + resolved.enum.map(String).join(', '));
    if (resolved.minimum !== undefined || resolved.maximum !== undefined)
      parts.push(boundLabel('', resolved.minimum, resolved.maximum));
    if (resolved.minLength !== undefined || resolved.maxLength !== undefined)
      parts.push(
        boundLabel('panjang ', resolved.minLength, resolved.maxLength),
      );
    if (resolved.minItems !== undefined || resolved.maxItems !== undefined)
      parts.push(boundLabel('item ', resolved.minItems, resolved.maxItems));
    if (resolved.description) parts.push(resolved.description);
    return parts.join(' — ');
  }

  // -------------------------------------------------------------------------
  // Renderers
  // -------------------------------------------------------------------------

  private inlineHtml(text: string): string {
    return escapeHtml(text)
      .replace(
        new RegExp(BT + '([^' + BT + ']+)' + BT, 'g'),
        '<code>' + DL + '1</code>',
      )
      .replace(/\*\*([^*]+)\*\*/g, '<strong>' + DL + '1</strong>');
  }

  private renderBlockHtml(block: Block): string {
    switch (block.kind) {
      case 'h2':
        return '<h2>' + this.inlineHtml(block.text) + '</h2>';
      case 'h3':
        return '<h3>' + this.inlineHtml(block.text) + '</h3>';
      case 'p':
        return '<p>' + this.inlineHtml(block.text) + '</p>';
      case 'list':
        return (
          '<ul>' +
          block.items
            .map((item) => '<li>' + this.inlineHtml(item) + '</li>')
            .join('') +
          '</ul>'
        );
      case 'code':
        return '<pre><code>' + escapeHtml(block.text) + '</code></pre>';
      case 'table':
        return [
          '<table><thead><tr>',
          block.head
            .map((cell) => '<th>' + this.inlineHtml(cell) + '</th>')
            .join(''),
          '</tr></thead><tbody>',
          block.rows
            .map(
              (row) =>
                '<tr>' +
                row
                  .map((cell) => '<td>' + this.inlineHtml(cell) + '</td>')
                  .join('') +
                '</tr>',
            )
            .join(''),
          '</tbody></table>',
        ].join('');
    }
  }

  private renderEndpointHtml(endpoint: Endpoint): string {
    const out: string[] = ['<div>'];
    out.push(
      '<h4><span class="method ' +
        endpoint.method.toLowerCase() +
        '">' +
        endpoint.method +
        '</span><code>' +
        escapeHtml(endpoint.path) +
        '</code>' +
        (endpoint.auth
          ? ' <span class="auth">bearer</span>'
          : ' <span class="muted">(publik)</span>') +
        '</h4>',
    );
    if (endpoint.summary)
      out.push('<p>' + this.inlineHtml(endpoint.summary) + '</p>');
    if (endpoint.parameters.length) {
      out.push(
        '<table><thead><tr><th>Parameter</th><th>Di</th><th>Wajib</th><th>Tipe</th><th>Catatan</th></tr></thead><tbody>',
      );
      for (const parameter of endpoint.parameters)
        out.push(
          '<tr><td><code>' +
            escapeHtml(parameter.name) +
            '</code></td><td>' +
            parameter.where +
            '</td><td>' +
            (parameter.required ? 'ya' : 'tidak') +
            '</td><td><code>' +
            escapeHtml(parameter.type) +
            '</code></td><td>' +
            this.inlineHtml(parameter.note) +
            '</td></tr>',
        );
      out.push('</tbody></table>');
    }
    if (endpoint.requestBody)
      out.push(
        '<p><strong>Body' +
          (endpoint.requestBody.required ? ' (wajib)' : '') +
          ':</strong></p>',
        this.schemaHtml(endpoint.requestBody.schema),
      );
    for (const response of endpoint.responses)
      out.push(
        '<p><strong>' +
          escapeHtml(response.status) +
          '</strong> ' +
          this.inlineHtml(response.description) +
          '</p>',
        this.schemaHtml(response.schema),
      );
    out.push('</div>');
    return out.join('\n');
  }

  /** Strips the { data } / { data, meta } envelope so detail is not lost. */
  private unwrapEnvelope(
    schema: SchemaLike | undefined,
    document: OpenAPIObject,
  ): SchemaLike | undefined {
    const resolved = this.deref(schema, document);
    const properties = resolved?.properties;
    if (!properties) return resolved;
    const keys = Object.keys(properties);
    if (!keys.includes('data')) return resolved;
    if (!keys.every((key) => key === 'data' || key === 'meta')) return resolved;
    return properties.data;
  }

  private schemaHtml(schema: SchemaLike | undefined): string {
    if (!schema) return '';
    const name = refName(schema);
    if (name)
      return '<p><code>' + escapeHtml(name) + '</code> — lihat Objects</p>';
    const unwrapped = this.unwrapEnvelope(schema, this.getDocument());
    const fields = this.fieldRows(unwrapped, this.getDocument());
    if (!fields.length)
      return (
        '<p><code>' +
        escapeHtml(this.typeLabel(unwrapped, this.getDocument())) +
        '</code></p>'
      );
    return (
      '<table><thead><tr><th>Field</th><th>Tipe</th><th>Wajib</th><th>Catatan</th></tr></thead><tbody>' +
      fields
        .map(
          (field) =>
            '<tr><td><code>' +
            escapeHtml(field.name) +
            '</code></td><td><code>' +
            escapeHtml(field.type) +
            '</code></td><td>' +
            (field.required ? 'ya' : 'tidak') +
            '</td><td>' +
            this.inlineHtml(field.note) +
            '</td></tr>',
        )
        .join('') +
      '</tbody></table>'
    );
  }

  private renderObjectHtml(object: ObjectView): string {
    return (
      '<h3 id="obj-' +
      escapeHtml(object.name) +
      '">' +
      escapeHtml(object.name) +
      '</h3>' +
      '<table><thead><tr><th>Field</th><th>Tipe</th><th>Wajib</th><th>Catatan</th></tr></thead><tbody>' +
      object.fields
        .map(
          (field) =>
            '<tr><td><code>' +
            escapeHtml(field.name) +
            '</code></td><td><code>' +
            escapeHtml(field.type) +
            '</code></td><td>' +
            (field.required ? 'ya' : 'tidak') +
            '</td><td>' +
            this.inlineHtml(field.note) +
            '</td></tr>',
        )
        .join('') +
      '</tbody></table>'
    );
  }

  private renderBlockMarkdown(block: Block): string {
    switch (block.kind) {
      case 'h2':
        return '## ' + block.text + '\n';
      case 'h3':
        return '### ' + block.text + '\n';
      case 'p':
        return block.text + '\n';
      case 'list':
        return block.items.map((item) => '- ' + item).join('\n') + '\n';
      case 'code':
        return [BT + BT + BT + block.lang, block.text, BT + BT + BT, ''].join(
          '\n',
        );
      case 'table':
        return [
          '| ' + block.head.join(' | ') + ' |',
          '| ' + block.head.map(() => '---').join(' | ') + ' |',
          ...block.rows.map((row) => '| ' + row.join(' | ') + ' |'),
          '',
        ].join('\n');
    }
  }

  private renderEndpointMarkdown(endpoint: Endpoint): string {
    const out: string[] = [
      '#### ' + endpoint.method + ' ' + endpoint.path,
      '',
      endpoint.summary + (endpoint.auth ? ' _(bearer)_' : ' _(publik)_'),
      '',
    ];
    if (endpoint.parameters.length) {
      out.push(
        '| Parameter | Di | Wajib | Tipe | Catatan |',
        '| --- | --- | --- | --- | --- |',
      );
      for (const parameter of endpoint.parameters)
        out.push(
          '| ' +
            parameter.name +
            ' | ' +
            parameter.where +
            ' | ' +
            (parameter.required ? 'ya' : 'tidak') +
            ' | ' +
            parameter.type +
            ' | ' +
            parameter.note.replaceAll('|', '\\|') +
            ' |',
        );
      out.push('');
    }
    if (endpoint.requestBody)
      out.push(
        '**Body' +
          (endpoint.requestBody.required ? ' (wajib)' : '') +
          ':** ' +
          this.schemaMarkdown(endpoint.requestBody.schema),
        '',
      );
    for (const response of endpoint.responses)
      out.push(
        '- **' +
          response.status +
          '** ' +
          response.description +
          ' ' +
          this.schemaMarkdown(response.schema),
      );
    out.push('');
    return out.join('\n');
  }

  private schemaMarkdown(schema: SchemaLike | undefined): string {
    if (!schema) return '';
    const name = refName(schema);
    if (name) return '-> ' + BT + name + BT + ' (lihat Objects)';
    const unwrapped = this.unwrapEnvelope(schema, this.getDocument());
    const fields = this.fieldRows(unwrapped, this.getDocument());
    if (!fields.length)
      return BT + this.typeLabel(unwrapped, this.getDocument()) + BT;
    return (
      '\n' +
      fields
        .map(
          (field) =>
            '  - ' +
            BT +
            field.name +
            BT +
            ': ' +
            BT +
            field.type +
            BT +
            (field.required ? ' (wajib)' : '') +
            (field.note ? ' — ' + field.note : ''),
        )
        .join('\n')
    );
  }
}

/** "range 1..10" / ">= 1" / "<= 500", never "1..-". */
function boundLabel(prefix: string, min?: number, max?: number): string {
  if (min !== undefined && max !== undefined)
    return prefix
      ? prefix + String(min) + '..' + String(max)
      : 'range ' + String(min) + '..' + String(max);
  if (min !== undefined) return prefix + '>= ' + String(min);
  return prefix + '<= ' + String(max);
}

/** Longest path prefix shared by every route, e.g. /api/v1. */
function commonBasePath(paths: string[]): string {
  if (!paths.length) return '';
  const segments = paths.map((path) => path.split('/'));
  const common: string[] = [];
  // Index 0 is the leading empty segment of every absolute path.
  for (let index = 1; ; index += 1) {
    const candidate = segments[0][index];
    if (!candidate) break;
    if (!segments.every((parts) => parts[index] === candidate)) break;
    common.push(candidate);
  }
  return '/' + common.join('/');
}
