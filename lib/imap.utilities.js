var tls = require('tls');

exports.MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
                  'Oct', 'Nov', 'Dec'];

exports.setSecure = function(tcpSocket) {
  var pair = tls.createSecurePair(),
      cleartext;

  pair.encrypted.pipe(tcpSocket);
  tcpSocket.pipe(pair.encrypted);
  pair.fd = tcpSocket.fd;

  cleartext = pair.cleartext;
  cleartext.socket = tcpSocket;
  cleartext.encrypted = pair.encrypted;

  function onerror(e) {
    if (cleartext._controlReleased)
      cleartext.emit('error', e);
  }

  function onclose() {
    tcpSocket.removeListener('error', onerror);
    tcpSocket.removeListener('close', onclose);
  }

  tcpSocket.on('error', onerror);
  tcpSocket.on('close', onclose);

  pair.on('secure', function() {
    process.nextTick(function() { cleartext.socket.emit('secure'); });
  });

  cleartext._controlReleased = true;
  return cleartext;
};

/**
 * Adopted from jquery's extend method. Under the terms of MIT License.
 *
 * http://code.jquery.com/jquery-1.4.2.js
 *
 * Modified by Brian White to use Array.isArray instead of the custom isArray
 * method
 */
exports.extend = function() {
  // copy reference to target object
  var target = arguments[0] || {},
      i = 1,
      length = arguments.length,
      deep = false,
      options,
      name,
      src,
      copy;

  // Handle a deep copy situation
  if (typeof target === "boolean") {
    deep = target;
    target = arguments[1] || {};
    // skip the boolean and the target
    i = 2;
  }

  // Handle case when target is a string or something (possible in deep copy)
  if (typeof target !== "object" && typeof target !== 'function')
    target = {};

  var isPlainObject = function(obj) {
    // Must be an Object.
    // Because of IE, we also have to check the presence of the constructor
    // property.
    // Make sure that DOM nodes and window objects don't pass through, as well
    if (!obj || toString.call(obj) !== "[object Object]" || obj.nodeType
        || obj.setInterval)
      return false;

    var has_own_constructor = hasOwnProperty.call(obj, "constructor");
    var has_is_prop_of_method = hasOwnProperty.call(obj.constructor.prototype,
                                                    "isPrototypeOf");
    // Not own constructor property must be Object
    if (obj.constructor && !has_own_constructor && !has_is_prop_of_method)
      return false;

    // Own properties are enumerated firstly, so to speed up,
    // if last one is own, then all properties are own.

    var last_key;
    for (var key in obj)
      last_key = key;

    return last_key === undefined || hasOwnProperty.call(obj, last_key);
  };


  for (; i < length; i++) {
    // Only deal with non-null/undefined values
    if ((options = arguments[i]) !== null) {
      // Extend the base object
      for (name in options) {
        src = target[name];
        copy = options[name];

        // Prevent never-ending loop
        if (target === copy)
            continue;

        // Recurse if we're merging object literal values or arrays
        if (deep && copy && (isPlainObject(copy) || Array.isArray(copy))) {
          var clone = src && (isPlainObject(src) || Array.isArray(src)
                              ? src : (Array.isArray(copy) ? [] : {}));

          // Never move original objects, clone them
          target[name] = exports.extend(deep, clone, copy);

        // Don't bring in undefined values
        } else if (copy !== undefined)
          target[name] = copy;
      }
    }
  }

  // Return the modified object
  return target;
};

exports.isNotEmpty = function(str) {
  return str.trim().length > 0;
};

exports.escape = function(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
};

exports.unescape = function(str) {
  return str.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
};

exports.buildSearchQuery = function(options, extensions, isOrChild) {
  var searchargs = '';
  for (var i=0,len=options.length; i<len; i++) {
    var criteria = (isOrChild ? options : options[i]),
        args = null,
        modifier = (isOrChild ? '' : ' ');
    if (typeof criteria === 'string')
      criteria = criteria.toUpperCase();
    else if (Array.isArray(criteria)) {
      if (criteria.length > 1)
        args = criteria.slice(1);
      if (criteria.length > 0)
        criteria = criteria[0].toUpperCase();
    } else
      throw new Error('Unexpected search option data type. '
                      + 'Expected string or array. Got: ' + typeof criteria);
    if (criteria === 'OR') {
      if (args.length !== 2)
        throw new Error('OR must have exactly two arguments');
      searchargs += ' OR (';
      searchargs += exports.buildSearchQuery(args[0], extensions, true);
      searchargs += ') (';
      searchargs += exports.buildSearchQuery(args[1], extensions, true);
      searchargs += ')';
    } else {
      if (criteria[0] === '!') {
        modifier += 'NOT ';
        criteria = criteria.substr(1);
      }
      switch(criteria) {
        // -- Standard criteria --
        case 'ALL':
        case 'ANSWERED':
        case 'DELETED':
        case 'DRAFT':
        case 'FLAGGED':
        case 'NEW':
        case 'SEEN':
        case 'RECENT':
        case 'OLD':
        case 'UNANSWERED':
        case 'UNDELETED':
        case 'UNDRAFT':
        case 'UNFLAGGED':
        case 'UNSEEN':
          searchargs += modifier + criteria;
        break;
        case 'BCC':
        case 'BODY':
        case 'CC':
        case 'FROM':
        case 'SUBJECT':
        case 'TEXT':
        case 'TO':
          if (!args || args.length !== 1)
            throw new Error('Incorrect number of arguments for search option: '
                            + criteria);
          searchargs += modifier + criteria + ' "' + exports.escape(''+args[0])
                     + '"';
        break;
        case 'BEFORE':
        case 'ON':
        case 'SENTBEFORE':
        case 'SENTON':
        case 'SENTSINCE':
        case 'SINCE':
          if (!args || args.length !== 1)
            throw new Error('Incorrect number of arguments for search option: '
                            + criteria);
          else if (!(args[0] instanceof Date)) {
            if ((args[0] = new Date(args[0])).toString() === 'Invalid Date')
              throw new Error('Search option argument must be a Date object'
                              + ' or a parseable date string');
          }
          searchargs += modifier + criteria + ' ' + args[0].getDate() + '-'
                        + exports.MONTHS[args[0].getMonth()] + '-'
                        + args[0].getFullYear();
        break;
        case 'KEYWORD':
        case 'UNKEYWORD':
          if (!args || args.length !== 1)
            throw new Error('Incorrect number of arguments for search option: '
                            + criteria);
          searchargs += modifier + criteria + ' ' + args[0];
        break;
        case 'LARGER':
        case 'SMALLER':
          if (!args || args.length !== 1)
            throw new Error('Incorrect number of arguments for search option: '
                            + criteria);
          var num = parseInt(args[0], 10);
          if (isNaN(num))
            throw new Error('Search option argument must be a number');
          searchargs += modifier + criteria + ' ' + args[0];
        break;
        case 'HEADER':
          if (!args || args.length !== 2)
            throw new Error('Incorrect number of arguments for search option: '
                            + criteria);
          searchargs += modifier + criteria + ' "' + exports.escape(''+args[0])
                     + '" "' + exports.escape(''+args[1]) + '"';
        break;
        case 'UID':
          if (!args)
            throw new Error('Incorrect number of arguments for search option: '
                            + criteria);
          exports.validateUIDList(args);
          searchargs += modifier + criteria + ' ' + args.join(',');
        break;
        // -- Extensions criteria --
        case 'X-GM-MSGID': // Gmail unique message ID
        case 'X-GM-THRID': // Gmail thread ID
          if (extensions.indexOf('X-GM-EXT-1') === -1)
            throw new Error('IMAP extension not available: ' + criteria);
          var val;
          if (!args || args.length !== 1)
            throw new Error('Incorrect number of arguments for search option: '
                            + criteria);
          else {
            val = ''+args[0];
            if (!(/^\d+$/.test(args[0])))
              throw new Error('Invalid value');
          }
          searchargs += modifier + criteria + ' ' + val;
        break;
        case 'X-GM-RAW': // Gmail search syntax
          if (extensions.indexOf('X-GM-EXT-1') === -1)
            throw new Error('IMAP extension not available: ' + criteria);
          if (!args || args.length !== 1)
            throw new Error('Incorrect number of arguments for search option: '
                            + criteria);
          searchargs += modifier + criteria + ' "' + exports.escape(''+args[0])
                     + '"';
        break;
        case 'X-GM-LABELS': // Gmail labels
          if (extensions.indexOf('X-GM-EXT-1') === -1)
            throw new Error('IMAP extension not available: ' + criteria);
          if (!args || args.length !== 1)
            throw new Error('Incorrect number of arguments for search option: '
                            + criteria);
          searchargs += modifier + criteria + ' ' + args[0];
        break;
        default:
          try {
            // last hope it's a seqno set
            // http://tools.ietf.org/html/rfc3501#section-6.4.4
            var seqnos = (args ? [criteria].concat(args) : [criteria]);
            exports.validateUIDList(seqnos);
            searchargs += modifier + seqnos.join(',');
          } catch(e) {
            throw new Error('Unexpected search option: ' + criteria);
          }
      }
    }
    if (isOrChild)
      break;
  }
  return searchargs;
};

exports.validateUIDList = function(uids) {
  for (var i=0,len=uids.length,intval; i<len; i++) {
    if (typeof uids[i] === 'string') {
      if (uids[i] === '*' || uids[i] === '*:*') {
        if (len > 1)
          uids = ['*'];
        break;
      } else if (/^(?:[\d]+|\*):(?:[\d]+|\*)$/.test(uids[i]))
        continue;
    }
    intval = parseInt(''+uids[i], 10);
    if (isNaN(intval)) {
      throw new Error('Message ID/number must be an integer, "*", or a range: '
                      + uids[i]);
    } else if (typeof uids[i] !== 'number')
      uids[i] = intval;
  }
};

var CHARR_CRLF = [13, 10];
function line(b, s) {
  var len = b.length, p = b.p, start = p, ret = false, retest = false;
  while (p < len && !ret) {
    if (b[p] === CHARR_CRLF[s.p]) {
      if (++s.p === 2)
        ret = true;
    } else {
      retest = (s.p > 0);
      s.p = 0;
      if (retest)
        continue;
    }
    ++p;
  }
  if (ret === false) {
    if (s.ret)
      s.ret += b.toString('ascii', start);
    else
      s.ret = b.toString('ascii', start);
  } else {
    var iCR = p - 2;
    if (iCR < 0) {
      // the CR is at the end of s.ret
      if (s.ret && s.ret.length > 1)
        ret = s.ret.substr(0, s.ret.length - 1);
      else
        ret = '';
    } else {
      // the entire CRLF is in b
      if (iCR === 0)
        ret = (s.ret ? s.ret : '');
      else {
        if (s.ret) {
          ret = s.ret;
          ret += b.toString('ascii', start, iCR);
        } else
          ret = b.toString('ascii', start, iCR);
      }
    }
    s.p = 0;
    s.ret = undefined;
  }
  b.p = p;
  return ret;
}

exports.line = line;
