'use strict';

// GitHub contents do not include upload dates. Use the latest commit affecting
// each path, pinned to the same branch snapshot as the directory listing.
async function listByRecentCommit(service, remotePath = '') {
  const { normalizeRepoPath } = require('./validation');
  const c = { ...service.getConfig() };
  const prefix = `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`;
  const clean = normalizeRepoPath(remotePath);
  const ref = await service.request(`${prefix}/git/ref/heads/${c.branch.split('/').map(encodeURIComponent).join('/')}`);
  const head = ref.object.sha;
  const suffix = clean ? `/${clean.split('/').map(encodeURIComponent).join('/')}` : '';
  let value;
  try { value = await service.request(`${prefix}/contents${suffix}?ref=${encodeURIComponent(head)}`); }
  catch (error) {
    if (error.status !== 404) throw error;
    // A removed configured root (or an empty repository tree) is an empty disk.
    const commit = await service.request(`${prefix}/git/commits/${head}`);
    let treeSha = commit.tree.sha;
    for (const segment of clean.split('/').filter(Boolean)) {
      const tree = await service.request(`${prefix}/git/trees/${treeSha}`);
      if (tree.truncated) throw error;
      const entry = tree.tree.find((item) => item.path === segment);
      if (!entry) return [];
      if (entry.type !== 'tree') throw error;
      treeSha = entry.sha;
    }
    const tree = await service.request(`${prefix}/git/trees/${treeSha}`);
    if (!tree.truncated && !tree.tree.length) return [];
    throw error;
  }
  const rows = (Array.isArray(value) ? value : [value]).map(({ name, path, type, size, sha, download_url }) => ({ name, path, type, size, sha, downloadUrl: download_url }));
  const cacheKey = `${prefix}:${c.branch}:${head}`;
  if (service.dateCacheKey !== cacheKey) { service.dateCacheKey = cacheKey; service.dateCache = new Map(); }
  const cache = service.dateCache;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
    while (next < rows.length) {
      const item = rows[next++];
      if (!cache.has(item.path)) {
        const commits = await service.request(`${prefix}/commits?sha=${encodeURIComponent(head)}&path=${encodeURIComponent(item.path)}&per_page=1`);
        const date = commits[0]?.commit?.committer?.date;
        cache.set(item.path, Number.isFinite(Date.parse(date)) ? date : null);
      }
      item.updatedAt = cache.get(item.path);
    }
  }));
  return rows.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.name.localeCompare(b.name));
}
module.exports = { listByRecentCommit };
