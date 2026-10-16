/**
 * validate(schema, 'body' | 'query' | 'params')
 * Parsed + coerced data lands in req.valid[source].
 * (Express 5 makes req.query read-only, so we don't overwrite it.)
 */
module.exports = (schema, source = 'body') => (req, res, next) => {
  req.valid = req.valid || {};
  req.valid[source] = schema.parse(req[source]); // throws ZodError -> error handler
  next();
};
