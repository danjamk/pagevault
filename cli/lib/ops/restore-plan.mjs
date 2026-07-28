//
// What a restore would actually do — the decision, separated from the doing.
//
// `make restore` is a bulk PUT, never a wipe. It writes back every key in the backup and deletes
// nothing. That makes "is the namespace empty?" the wrong question, and asking it was the bug in
// #125: a namespace holding one throwaway sample document got the same flat refusal as one holding
// a live client portal, with `--force` as the only visible way forward. The right question is
// which keys the backup does NOT replace, because those are the ones that survive and mix in.
//
// Pure and side-effect free so it can be tested. `scripts/kv-restore.mjs` runs on import, so the
// logic cannot live there and still be reachable from a test.
//

/**
 * The title `verify` publishes its sample document under.
 *
 * Imported by `cli/lib/ops/verify.mjs` so the two cannot drift. If they ever did, the drift would
 * be silent — restore would stop recognising the sample and start calling it real data, which is
 * a worse-than-useless failure mode during a recovery.
 */
export const SAMPLE_TITLE = "Welcome to PageVault";

const DOC_KEY = /^(?:doc|raw|meta):(.+)$/;
const IDX_KEY = /^idx:[^:]*:(.+)$/;

/**
 * Work out what a restore into this namespace would leave behind.
 *
 * @param liveKeys  keys currently in the namespace, as the KV list API returns them:
 *                  `{ name, metadata? }`
 * @param backupKeys the key names the backup file carries
 */
export function planRestore(liveKeys, backupKeys) {
  const backup = backupKeys instanceof Set ? backupKeys : new Set(backupKeys);
  const surviving = liveKeys.filter((k) => !backup.has(k.name));
  return {
    surviving,
    overwritten: liveKeys.length - surviving.length,
    // Only meaningful when something survives; an empty namespace is not "a sample".
    isSampleOnly: surviving.length > 0 && onlySampleDocuments(surviving),
    summary: summarize(surviving),
  };
}

/**
 * Group keys into things an operator can recognise under stress.
 *
 * Returns structured entries rather than formatted strings so the caller owns the colour, and so
 * a test can assert on what was counted instead of on punctuation.
 *
 * Every key lands in exactly one bucket. A key that fell through would be a key someone decided
 * about without ever seeing it, which is the whole failure this exists to prevent.
 */
export function summarize(keys) {
  const titles = new Map();
  for (const k of keys) {
    const id = /^meta:(.+)$/.exec(k.name)?.[1];
    if (id && k.metadata?.title) titles.set(id, k.metadata.title);
  }

  const docIds = new Set();
  let portals = 0;
  let links = 0;
  let other = 0;
  for (const k of keys) {
    const id = DOC_KEY.exec(k.name)?.[1] ?? IDX_KEY.exec(k.name)?.[1];
    if (id) docIds.add(id);
    else if (/^(?:portal|members):/.test(k.name)) portals++;
    else if (/^pub:/.test(k.name)) links++;
    else other++;
  }

  const out = [...docIds].map((id) => ({ type: "document", id, title: titles.get(id) ?? null }));
  if (portals) out.push({ type: "portal", count: portals });
  if (links) out.push({ type: "link", count: links });
  if (other) out.push({ type: "other", count: other });
  return out;
}

/**
 * Is everything here just the disposable document `verify` publishes?
 *
 * Deliberately narrow: exactly one document, titled exactly what `verify` titles it, plus the
 * portal and public-link keys that come with a fresh deployment. Anything looser risks telling
 * someone a real deliverable is disposable — an error that costs far more than one extra `FORCE=1`.
 */
export function onlySampleDocuments(keys) {
  const metas = keys.filter((k) => k.name.startsWith("meta:"));
  if (metas.length !== 1) return false;
  if (metas[0].metadata?.title !== SAMPLE_TITLE) return false;

  // `verify` publishes with public:true, so the sample mints exactly one capability token. More
  // than one means `pub:` keys pointing at documents we cannot see from here — a token is opaque,
  // so there is no way to tell whose link it is. Refuse rather than vouch for it.
  if (keys.filter((k) => k.name.startsWith("pub:")).length > 1) return false;

  const id = metas[0].name.slice("meta:".length);
  return keys.every((k) => k.name.endsWith(`:${id}`) || /^(?:portal|members|pub):/.test(k.name));
}
