// Tool-result images.
//
// Mirrors internal/protocol/tool_images.go. A tool result may come back as a
// list of content blocks rather than a string, and those blocks can carry
// images. Each downstream protocol needs them in a different place: Responses
// takes input_image inside the function_call_output, Anthropic takes image
// blocks inside the tool_result, and Chat can only hold a string in a tool
// message, so its images are lifted into an extra user message right after the
// tool result. Anything that is not an image-bearing list passes through
// unchanged, so legacy text and opaque results keep their exact shape.

import type { ZenContentPart, ZenProtocol } from './types.js';

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringAt(value: unknown, key: string): string {
  const item = isRecord(value) ? value[key] : undefined;
  return typeof item === 'string' ? item : '';
}

/** True when the key exists at all, even with a null value. */
function hasKey(value: unknown, key: string): boolean {
  return isRecord(value) && value[key] !== undefined && value[key] !== null;
}

function typeOf(value: unknown): string {
  return stringAt(value, 'type');
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

// image_url is either a bare string or an object holding url, depending on the
// client. Both forms carry the same value.
function imageUrlOfRecord(part: RecordLike): string {
  const value = part['image_url'];
  if (typeof value === 'string') return value;
  return stringAt(value, 'url');
}

/**
 * The wire URL of an image part, reconstructing a data: URI from inline bytes
 * when the image was carried as mediaType + data instead of a URL.
 */
export function imageUrlOf(part: ZenContentPart): string {
  const url = part.image_url?.url ?? '';
  if (url) return url;
  if (!part.mediaType || part.data === undefined) return '';
  return `data:${part.mediaType};base64,${part.data}`;
}

function decodeOpenAIParts(parts: unknown[]): ZenContentPart[] {
  const out: ZenContentPart[] = [];
  for (const raw of parts) {
    if (!isRecord(raw)) throw new Error('OpenAI content block must be an object');
    if (typeOf(raw) === 'input_text') {
      out.push({ type: 'text', text: stringAt(raw, 'text') });
    } else if (typeOf(raw) === 'input_image') {
      out.push({ type: 'image_url', image_url: { url: imageUrlOfRecord(raw) } });
    }
  }
  return out;
}

function decodeAnthropicParts(parts: unknown[]): ZenContentPart[] {
  const out: ZenContentPart[] = [];
  for (const raw of parts) {
    if (!isRecord(raw)) throw new Error('Anthropic content block must be an object');
    if (typeOf(raw) === 'text') {
      out.push({ type: 'text', text: stringAt(raw, 'text') });
    } else if (typeOf(raw) === 'image') {
      const source = raw['source'];
      if (typeOf(source) === 'url') {
        out.push({ type: 'image_url', image_url: { url: stringAt(source, 'url') } });
      } else {
        out.push({
          type: 'image_url',
          image_url: { url: '' },
          mediaType: stringAt(source, 'media_type'),
          data: stringAt(source, 'data'),
        });
      }
    }
  }
  return out;
}

/**
 * Decodes an image-bearing tool result into the shared part list, validating
 * each block on the way. Mirrors decodeToolImages: only a list that actually
 * contains an image block is touched, and a block outside the text/image pair
 * is an error rather than a silent drop.
 */
export function decodeToolImages(from: ZenProtocol, value: unknown): ZenContentPart[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const anthropic = from === 'anthropic';
  const imageType = anthropic ? 'image' : 'input_image';
  const textType = anthropic ? 'text' : 'input_text';

  if (!value.some((raw) => typeOf(raw) === imageType)) return undefined;

  for (let i = 0; i < value.length; i += 1) {
    const part = value[i]!;
    if (!isRecord(part)) throw new Error(`content[${i}] must be an object`);
    switch (typeOf(part)) {
      case textType: {
        if (typeof part['text'] !== 'string') throw new Error(`content[${i}] requires text`);
        break;
      }
      case imageType: {
        if (anthropic) {
          const source = part['source'];
          const valid =
            typeOf(source) === 'url'
              ? stringAt(source, 'url') !== '' &&
                !hasKey(source, 'data') &&
                !hasKey(source, 'file_id')
              : typeOf(source) === 'base64' &&
                stringAt(source, 'data') !== '' &&
                stringAt(source, 'media_type').startsWith('image/') &&
                !hasKey(source, 'url') &&
                !hasKey(source, 'file_id');
          if (!valid) {
            throw new Error(`content[${i}] has an unsupported or conflicting image source`);
          }
          break;
        }
        if (imageUrlOfRecord(part) === '' || hasKey(part, 'file_id')) {
          throw new Error(`content[${i}] requires an image URL without a file reference`);
        }
        break;
      }
      default:
        throw new Error(`content[${i}] contains an unsupported block alongside tool images`);
    }
  }

  const parts = anthropic ? decodeAnthropicParts(value) : decodeOpenAIParts(value);

  // OpenAI carries base64 images inside the URL; Anthropic already splits them,
  // so only the OpenAI form needs the data: URI peeled apart.
  if (!anthropic) {
    parts.forEach((part, i) => {
      if (part.type !== 'image_url') return;
      const url = part.image_url?.url ?? '';
      if (!url.startsWith('data:')) return;
      const body = url.slice('data:'.length);
      const comma = body.indexOf(',');
      const header = comma === -1 ? body : body.slice(0, comma);
      const data = comma === -1 ? '' : body.slice(comma + 1);
      const suffix = ';base64';
      const base64 = header.endsWith(suffix);
      const media = base64 ? header.slice(0, header.length - suffix.length) : header;
      if (comma === -1 || !base64 || !media.startsWith('image/') || data === '') {
        throw new Error(`content[${i}] has an invalid image data URI`);
      }
      part.image_url = { url: '' };
      part.mediaType = media;
      part.data = data;
    });
  }

  return parts;
}

export interface ChatToolResult {
  text: string;
  images: ZenContentPart[];
}

/**
 * Splits a tool result into the text Chat can carry and the image blocks that
 * have to travel separately. Mirrors chatToolImages: each image gets a marker
 * text block so a consumer re-emitting the text keeps the same order as the
 * images, and the markers are also appended to the text itself so the
 * association survives a transcript that drops the extra message.
 *
 * `json.Marshal` of the call id produces a JSON string literal, so the marker
 * carries it quoted.
 */
export function chatToolImages(value: unknown, callId: string): ChatToolResult {
  if (!Array.isArray(value)) return { text: textOf(value), images: [] };

  let text = '';
  const images: ZenContentPart[] = [];
  let index = 0;
  for (const raw of value) {
    if (isRecord(raw) && typeOf(raw) === 'text') {
      text += stringAt(raw, 'text');
      continue;
    }
    index += 1;
    const marker = `[tool_image call_id="${callId}" index=${index}]`;
    text += `\n${marker}\n`;
    images.push({ type: 'text', text: marker }, raw as ZenContentPart);
  }
  return { text, images };
}

/**
 * Renders a tool result for the Responses function_call_output, which takes a
 * block list rather than a string. Mirrors responsesToolContent: a data: URI
 * is rebuilt from mediaType + data when no URL was carried.
 */
export function responsesToolContent(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((raw) =>
    isRecord(raw) && typeOf(raw) === 'text'
      ? { type: 'input_text', text: stringAt(raw, 'text') }
      : { type: 'input_image', image_url: imageUrlOf(raw as ZenContentPart) },
  );
}
