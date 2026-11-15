/**
 * Accepted image types for POST /media.
 *
 * The allowlist is deliberately narrow: only formats a mobile camera roll and a
 * web file picker actually produce, and only formats whose dimensions can be
 * read from the file header without decoding the pixels. SVG is excluded on
 * purpose - an uploaded SVG is executable markup, and serving it from the API
 * origin would be a script-injection vector, not just an image.
 */
export const MEDIA_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type MediaContentType = (typeof MEDIA_CONTENT_TYPES)[number];

/**
 * What the file is for. Recorded so an operator can reason about retention and
 * so a future per-purpose policy (size, moderation) has something to key on.
 * The purpose does NOT grant permission: whoever may attach the file to a menu
 * item or a case still needs the permission of that endpoint.
 */
export const MEDIA_PURPOSES = [
  'menu_item',
  'tenant_logo',
  'tenant_cover',
  'avatar',
  'case_evidence',
] as const;

export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];

/** Extension written to disk for each accepted type. */
export const MEDIA_EXTENSIONS: Record<MediaContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Hard ceiling enforced by both the multipart parser and the database CHECK.
 * MEDIA_MAX_BYTES can lower it but never raise it past this.
 */
export const MEDIA_ABSOLUTE_MAX_BYTES = 20971520;

export const MEDIA_DEFAULT_MAX_BYTES = 5242880;
