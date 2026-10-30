'use strict';
// Names, slugs and emoji helpers. No VS Code dependency.

// Folder names Windows refuses to create, with or without an extension.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** @param {string} name */
function slugify(name) {
  const slug =
    String(name)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
      .replace(/-+$/, '') || 'account';
  return WINDOWS_RESERVED.test(slug) ? `${slug}-account` : slug;
}

/** @param {string} s */
function graphemes(s) {
  const text = String(s);
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((x) => x.segment);
  }
  return [...text];
}

/** @param {string} name */
function initials(name) {
  const words = String(name)
    .replace(/[()~/.]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length === 1 ? graphemes(words[0]).slice(0, 2).join('') : graphemes(words[0])[0] + graphemes(words[1])[0];
  return letters.toUpperCase();
}

// One user-perceived character that is an emoji (including ZWJ sequences, flags and keycaps).
/** @param {string} s */
function isSingleEmoji(s) {
  const text = String(s || '').trim();
  if (!text) return false;
  const parts = graphemes(text);
  if (parts.length !== 1) return false;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(text);
}

// Codicon ids are lower-case words separated by dashes.
/** @param {string | undefined} icon */
const isCodiconId = (icon) => /^[a-z][a-z0-9-]*$/.test(icon || '');

// Masks an e-mail for reports: "jane.doe@example.com" -> "j***@example.com".
/** @param {string | null | undefined} email */
function maskEmail(email) {
  if (!email) return '';
  const at = email.indexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

module.exports = { slugify, initials, graphemes, isSingleEmoji, isCodiconId, maskEmail, WINDOWS_RESERVED };
