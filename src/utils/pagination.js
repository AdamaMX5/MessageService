// Parses page/limit query params into a { page, limit, skip } triple.
// Defaults differ per endpoint (DMs use 20, channels use 100), so they are
// passed in by the caller; maxLimit caps client-supplied values.
function parsePagination(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page  = Math.max(1, parseInt(query.page)  || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

module.exports = parsePagination;
