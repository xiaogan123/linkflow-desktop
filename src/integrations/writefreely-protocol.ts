/** Pure WriteFreely API shapes shared by Paper.wf and the rant.li instance. */
const USERNAME = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const POST_ID = /^[a-zA-Z0-9]{10,64}$/;
const MAX_ARTICLE_BYTES = 256 * 1024;

export const WRITEFREELY_SIGNUP_PATH = '/api/auth/signup';
export interface WriteFreelyPost { id: string; slug: string; title: string; body: string; collectionAlias?: string }

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function writeFreelyCollectionPostsPath(username: string, slug?: string): string | undefined {
  if (!USERNAME.test(username) || slug !== undefined && (!SLUG.test(slug) || slug.length > 100)) return;
  return `/api/collections/${username}/posts${slug === undefined ? '' : `/${slug}`}`;
}

export function writeFreelyPublicPostUrl(origin: string, username: string, slug: string): string | undefined {
  if (!USERNAME.test(username) || !SLUG.test(slug) || slug.length > 100 || !/^https:\/\/[a-z0-9.-]+$/i.test(origin)) return;
  return `${origin}/${username}/${slug}`;
}

export function writeFreelyPostPayload(title: string, body: string, slug: string) {
  return { title, body, slug };
}

/** The API returns a code/data envelope, including on signup and public reads. */
export function writeFreelyEnvelope(value: unknown): { data: unknown } | undefined {
  if (!object(value) || !Number.isInteger(value.code) || Number(value.code) < 200 || Number(value.code) >= 300 || !('data' in value)) return;
  return { data: value.data };
}

export function writeFreelyPost(value: unknown): WriteFreelyPost | undefined {
  if (!object(value) || typeof value.id !== 'string' || !POST_ID.test(value.id)
    || typeof value.slug !== 'string' || !SLUG.test(value.slug) || value.slug.length > 100
    || typeof value.title !== 'string' || typeof value.body !== 'string'
    || Buffer.byteLength(value.body, 'utf8') > MAX_ARTICLE_BYTES) return;
  let collectionAlias: string | undefined;
  if (value.collection !== undefined) {
    if (!object(value.collection) || typeof value.collection.alias !== 'string' || !USERNAME.test(value.collection.alias)) return;
    collectionAlias = value.collection.alias;
  }
  return { id: value.id, slug: value.slug, title: value.title, body: value.body, ...(collectionAlias ? { collectionAlias } : {}) };
}

export function writeFreelyPostMatches(post: WriteFreelyPost, article: { slug: string; title: string; markdown: string }, username: string, postId?: string): boolean {
  return post.slug === article.slug && post.title === article.title && post.body === article.markdown
    && (!postId || post.id === postId) && (!post.collectionAlias || post.collectionAlias === username);
}
