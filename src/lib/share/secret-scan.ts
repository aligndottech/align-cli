/**
 * L9: the client-side secret scan for `align share`. Refuse and SHOW which kind of secret was found,
 * never the secret itself: the match is not printed, logged or returned, only its placeholder name.
 *
 * `secret-patterns.json` is vendored byte for byte from align-stack `config/secret-patterns.json`
 * (last changed in align-stack commit 292e07017). It is the same list brain redacts with and the
 * gateway refuses on at POST /ingest/batch, so a share that passes here is not refused there for a
 * credential shape. `share-secret-patterns.test.ts` pins the file's sha256 and one positive and one
 * near-miss per newer shape; a pattern added server-side but not copied here only means the SERVER
 * refuses a share this scan let through, so re-vendor the file and update that pin together.
 */
import patterns from './secret-patterns.json' with { type: 'json' };

export interface SecretFinding {
  /** Which field of the share held it: `title`, `summary`, `source_url`, `note`. */
  field: string;
  /** The placeholder the redactor would write, for example `<GITHUB_TOKEN>`. Never the match. */
  placeholder: string;
}

const placeholderOf = (replacement: string): string => /<[A-Z0-9_]+>/.exec(replacement)?.[0] ?? '<SECRET>';

/**
 * One local change to the vendored list, made at compile time so the file stays byte for byte the server's: the
 * env-style name pattern's unbounded `[A-Z0-9_]*` halves are capped at 64 characters each. Unbounded, a long run of
 * capitals with the word repeated in it (an env dump, `XTOKENX` x 28,571) backtracks once per repeat: 3.3 s on
 * 200 KB. A variable name longer than 64 characters on either side of the word is the only thing it now misses.
 */
const bounded = (p: string): string => p.split('[A-Z0-9_]*').join('[A-Z0-9_]{0,64}');

interface Compiled { re: RegExp; placeholder: string }
const COMPILED: Compiled[] = [
  ...patterns.case_insensitive.map(([p, r]) => ({ re: new RegExp(bounded(p as string), 'i'), placeholder: placeholderOf(r as string) })),
  ...patterns.case_sensitive.map(([p, r]) => ({ re: new RegExp(bounded(p as string)), placeholder: placeholderOf(r as string) })),
];
const AWS_BARE = new RegExp(patterns.aws_bare_secret, 'g');
const AWS_CONTEXT = patterns.aws_context_chars;

/** Placeholder names found in `text`, each once, in pattern order. */
export function secretsIn(text: string): string[] {
  const found: string[] = [];
  for (const c of COMPILED) if (c.re.test(text) && !found.includes(c.placeholder)) found.push(c.placeholder);
  // The bare AWS secret shape is only a secret near the word "aws", exactly as the server decides.
  AWS_BARE.lastIndex = 0;
  for (let m = AWS_BARE.exec(text); m; m = AWS_BARE.exec(text)) {
    const near = text.slice(Math.max(0, m.index - AWS_CONTEXT), m.index + m[0].length + AWS_CONTEXT).toLowerCase();
    if (near.includes('aws') && !found.includes('<AWS_SECRET_KEY>')) found.push('<AWS_SECRET_KEY>');
  }
  return found;
}

/** Scan every named field; one finding per (field, placeholder). */
export function scanForSecrets(fields: Array<{ field: string; text: string | null | undefined }>): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const f of fields) {
    if (!f.text) continue;
    for (const placeholder of secretsIn(f.text)) out.push({ field: f.field, placeholder });
  }
  return out;
}

/**
 * Query parameters that carry a secret in the URL itself (a Zoom `pwd`, a signed link's signature, a token).
 * The decision's URL is sent and shown, so one of these is refused like a token in the text, never stripped:
 * stripping would change which item the URL names. The VALUE is never reported, only the parameter name.
 */
const SECRET_PARAMS = /^(?:token|access[_-]?token|id[_-]?token|refresh[_-]?token|api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|passcode|sig|signature|x-amz-signature|x-amz-credential|auth|authorization)$/i;

export function scanSourceUrl(url: string): SecretFinding[] {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return []; }
  const names = new Set<string>();
  for (const [k, v] of parsed.searchParams) if (v !== '' && SECRET_PARAMS.test(k)) names.add(k.toLowerCase());
  return [...names].map((n) => ({ field: `source_url (parameter ${n})`, placeholder: '<URL_SECRET_PARAM>' }));
}

/**
 * Tag characters (U+E0000-E007F) render as nothing but a model reads them as text, so they can hide an
 * instruction inside a title or note. The secret scan cannot see them and a person cannot either, so a share
 * containing one is refused (naming the field) rather than sent.
 */
const HIDDEN = /[\u{E0000}-\u{E007F}]/u;

export function scanHiddenText(fields: Array<{ field: string; text: string | null | undefined }>): SecretFinding[] {
  return fields.filter((f) => f.text && HIDDEN.test(f.text)).map((f) => ({ field: f.field, placeholder: '<HIDDEN_TEXT>' }));
}

export interface Redaction { text: string; count: number }

/**
 * The same list, for REWRITING instead of refusing: what local capture, `align mark`, every import
 * and MCP align_capture run before anything reaches the local graph. Each match becomes the
 * pattern's own replacement, exactly as brain redacts server-side: its `\1` is filled from the match,
 * so a captured prefix such as `password: ` or `postgres://` is kept and only the secret goes. Applied in
 * list order, each pattern over the previous one's output, like the server. `count` is the number
 * of spans replaced. The raw value is never returned, logged or stored.
 */
interface Rewrite { re: RegExp; replacement: string }
const REWRITES: Rewrite[] = [
  ...patterns.case_insensitive.map(([p, r]) => ({ re: new RegExp(bounded(p as string), 'gi'), replacement: r as string })),
  ...patterns.case_sensitive.map(([p, r]) => ({ re: new RegExp(bounded(p as string), 'g'), replacement: r as string })),
];

/**
 * A content digest (`sha256:9f86d0...`) has the `label:value` shape the generic credentials pattern claims. Brain
 * redacts it too, but there the original is kept elsewhere; here the redacted text IS the only copy, so a digest in a
 * commit message or a decision would be lost for nothing. Kept as written, and not counted.
 */
const DIGEST = /^(?:sha(?:1|224|256|384|512)|md5|blake2[bs]?):[0-9a-f]+$/i;

export function redactSecrets(text: string): Redaction {
  let count = 0;
  let out = text;
  for (const w of REWRITES) {
    out = out.replace(w.re, (...args: unknown[]) => {
      if (w.replacement === '<CREDENTIALS>' && DIGEST.test(args[0] as string)) return args[0] as string;
      count += 1;
      // replace() passes the match, then each capture group, then the offset (the first number).
      const groups = args.slice(1, args.findIndex((a, i) => i > 0 && typeof a === 'number'));
      return w.replacement.replace(/\\(\d)/g, (_m, d: string) => String(groups[Number(d) - 1] ?? ''));
    });
  }
  // The bare AWS secret shape, only near the word "aws" (secretsIn's rule, judged on the text as it stands now).
  const source = out;
  out = source.replace(AWS_BARE, (m: string, offset: number) => {
    const near = source.slice(Math.max(0, offset - AWS_CONTEXT), offset + m.length + AWS_CONTEXT).toLowerCase();
    if (!near.includes('aws')) return m;
    count += 1;
    return '<AWS_SECRET_KEY>';
  });
  return { text: out, count };
}
