const jwt = require('jsonwebtoken');
const config = require('../config');
const { unauthorized } = require('../utils/errors');

/** Verifies the Bearer token and attaches the fresh user row to req.user. */
module.exports = (db) => {
  const findUser = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?');

  return (req, res, next) => {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token) throw unauthorized();

    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch {
      throw unauthorized('Invalid or expired token');
    }

    const user = findUser.get(payload.sub);
    if (!user) throw unauthorized('User no longer exists');
    req.user = user;
    console.log('0. auth ok')
    next();
    
  };
};
