// Wraps an async Express handler so that a rejected promise is forwarded to the
// central error handler. Without this, Express 4 leaves async throws as
// unhandled rejections instead of producing a clean 500.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
