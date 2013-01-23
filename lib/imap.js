var assert = require('assert'),
    tls = require('tls'),
    isDate = require('util').isDate,
    inspect = require('util').inspect,
    inherits = require('util').inherits,
    Socket = require('net').Socket,
    EventEmitter = require('events').EventEmitter,
    utf7 = require('utf7').imap,
    // customized copy of XRegExp to deal with multiple variables of the same
    // name
    XRegExp = require('./xregexp').XRegExp;

var parsers = require('./imap.parsers'),
    utils = require('./imap.utilities');

// main constants
var CRLF = '\r\n',
    STATES = {
      NOCONNECT: 0,
      NOAUTH: 1,
      AUTH: 2,
      BOXSELECTING: 3,
      BOXSELECTED: 4
    },
    RE_LITHEADER = /(?:((?:BODY\[.*\](?:<\d+>)?)?|[^ ]+) )?\{(\d+)\}$/i,
    RE_UNRESP = /^\* (OK|PREAUTH|NO|BAD) (?:\[(.+)\] )?(.+)$/i,
    //RE_ISPARTIAL = /<(\d+)>$/,
    RE_DBLQ = /"/g,
    RE_CMD = /^([^ ]+)(?: |$)/,
    RE_ISHEADER = /HEADER/,
    REX_UNRESPDATA = XRegExp('^\\* (?:(?:(?<type>NAMESPACE) (?<personal>(?:NIL|\\((?:\\(.+\\))+\\))) (?<other>(?:NIL|\\((?:\\(.+\\))+\\))) (?<shared>(?:NIL|\\((?:\\(.+\\))+\\))))|(?:(?<type>FLAGS) \\((?<flags>.*)\\))|(?:(?<type>LIST|LSUB|XLIST) \\((?<flags>.*)\\) (?<delimiter>".+"|NIL) (?<mailbox>.+))|(?:(?<type>(SEARCH|SORT))(?: (?<results>.*))?)|(?:(?<type>STATUS) (?<mailbox>.+) \\((?<attributes>.*)\\))|(?:(?<type>CAPABILITY) (?<capabilities>.+))|(?:(?<type>BYE) (?:\\[(?<code>.+)\\] )?(?<message>.+)))$', 'i'),
    REX_UNRESPNUM = XRegExp('^\\* (?<num>\\d+) (?:(?<type>EXISTS)|(?<type>RECENT)|(?<type>EXPUNGE)|(?:(?<type>FETCH) \\((?<info>.*)\\)))$', 'i');

// extension constants
var IDLE_NONE = 1,
    IDLE_WAIT = 2,
    IDLE_READY = 3,
    IDLE_DONE = 4;

function ImapConnection(options) {
  if (!(this instanceof ImapConnection))
    return new ImapConnection(options);
  EventEmitter.call(this);

  this._options = {
    username: options.username || options.user || '',
    password: options.password || '',
    host: options.host || 'localhost',
    port: options.port || 143,
    secure: options.secure || false,
    connTimeout: options.connTimeout || 10000, // connection timeout in msecs
    xoauth: options.xoauth,
    xoauth2: options.xoauth2
  };

  this._state = {
    status: STATES.NOCONNECT,
    conn: null,
    curId: 0,
    requests: [],
    numCapRecvs: 0,
    isReady: false,
    isIdle: true,
    tmrKeepalive: null,
    tmoKeepalive: 10000,
    tmrConn: null,
    indata: {
      literals: [],
      line: undefined,
      line_s: { p: 0, ret: undefined },
      temp: undefined,
      streaming: false,
      expect: -1
    },
    box: {
      uidnext: 0,
      readOnly: false,
      flags: [],
      newKeywords: false,
      uidvalidity: 0,
      keywords: [],
      permFlags: [],
      name: null,
      messages: { total: 0, new: 0 },
      _newName: undefined
    },
    ext: {
      // Capability-specific state info
      idle: {
        MAX_WAIT: 1740000, // 29 mins in ms
        state: IDLE_NONE,
        reIDLE: false,
        timeStarted: undefined
      }
    }
  };

  if (typeof options.debug === 'function')
    this.debug = options.debug;
  else
    this.debug = false;

  this.delimiter = undefined;
  this.namespaces = { personal: [], other: [], shared: [] };
  this.capabilities = [];
  this.connected = false;
  this.authenticated = false;
}

inherits(ImapConnection, EventEmitter);
module.exports = ImapConnection;
module.exports.ImapConnection = ImapConnection;

ImapConnection.prototype.connect = function(loginCb) {
  this._reset();

  var self = this,
      state = this._state,
      requests = state.requests,
      indata = state.indata;

  var socket = state.conn = new Socket();
  socket.setKeepAlive(true);
  socket.setTimeout(0);

  if (this._options.secure) {
    if (process.version.indexOf('v0.6.') > -1)
      socket = tls.connect(null, { socket: state.conn }, onconnect);
    else
      socket = tls.connect({ socket: state.conn }, onconnect);
  } else
    state.conn.once('connect', onconnect);

  function onconnect() {
    state.conn = socket; // re-assign for secure connections
    state.connected = true;
    state.authenticated = false;
    self.debug&&self.debug('[connection] Connected to host.');
    state.status = STATES.NOAUTH;
  };

  state.conn.on('end', function() {
    state.connected = false;
    state.authenticated = false;
    self.debug&&self.debug('[connection] FIN packet received. Disconnecting...');
    clearTimeout(state.tmrConn);
    self.emit('end');
  });

  state.conn.on('close', function(had_error) {
    self._reset();
    requests = state.requests;
    state.connected = false;
    state.authenticated = false;
    self.debug&&self.debug('[connection] Connection closed.');
    self.emit('close', had_error);
  });

  state.conn.on('error', function(err) {
    clearTimeout(state.tmrConn);
    err.level = 'socket';
    if (state.status === STATES.NOCONNECT)
      loginCb(err);
    else
      self.emit('error', err);
    self.debug&&self.debug('[connection] Error occurred: ' + err);
  });

  socket.on('ready', function() {
    var checkedNS = false;
    var reentry = function(err) {
      if (err) {
        state.conn.destroy();
        return loginCb(err);
      }
      // Next, get the list of available namespaces if supported (RFC2342)
      if (!checkedNS && self._serverSupports('NAMESPACE')) {
        // Re-enter this function after we've obtained the available
        // namespaces
        checkedNS = true;
        return self._send('NAMESPACE', reentry);
      }
      // Lastly, get the top-level mailbox hierarchy delimiter used by the
      // server
      self._send('LIST "" ""', loginCb);
    };
    // First, get the supported (pre-auth or otherwise) capabilities:
    self._send('CAPABILITY', function() {
      // No need to attempt the login sequence if we're on a PREAUTH
      // connection.
      if (state.status !== STATES.AUTH) {
        // First get pre-auth capabilities, including server-supported auth
        // mechanisms
        self._login(reentry);
      } else
        reentry();
    });
  });

  function read(b) {
    var blen = b.length, origPos = b.p;
    if (indata.expect <= (blen - b.p)) {
      var left = indata.expect;
      indata.expect = 0;
      b.p += left;
      return b.slice(origPos, origPos + left);
    } else {
      indata.expect -= (blen - b.p);
      b.p = blen;
      return origPos > 0 ? b.slice(origPos) : b;
    }
  }

  function emitLitData(key, data) {
    var fetches = requests[0].fetchers[key.replace(RE_DBLQ, '')];
    for (var i=0, len=fetches.length; i<len; ++i)
      fetches[i]._msg.emit('data', data);
  }

  function emitLitMsg(key, msg) {
    var fetches = requests[0].fetchers[key.replace(RE_DBLQ, '')];
    for (var i=0, len=fetches.length; i<len; ++i) {
      if (!fetches[i]._msg) {
        fetches[i]._msg = msg;
        fetches[i].emit('message', msg);
      }
    }
  }

  function emitMsgEnd(key) {
    var fetches = requests[0].fetchers[key.replace(RE_DBLQ, '')];
    for (var i=0, len=fetches.length; i<len; ++i) {
      if (fetches[i]._msg) {
        fetches[i]._msg.emit('end');
        fetches[i]._msg = undefined;
      }
    }
  }

  socket.on('data', ondata);

  function ondata(b) {
    b.p || (b.p = 0);
    if (b.length === 0 || b.p >= b.length) return;
    self.debug&&self.debug('\n<== ' + inspect(b.toString('binary', b.p)) + '\n');

    var r, m, litType, i, len, msg, fetches, f, lenf;
    if (indata.expect > 0) {
      r = read(b);
      if (indata.streaming) {
        //requests[0].fetchers[requests[0].key].msg.emit('data', r);
        emitLitData(requests[0].key, r);
        if (indata.expect === 0)
          indata.streaming = false;
      } else {
        if (indata.temp)
          indata.temp += r.toString('binary');
        else
          indata.temp = r.toString('binary');
        if (indata.expect === 0) {
          indata.literals.push(indata.temp);
          indata.temp = undefined;
        }
      }
      if (b.p >= b.length)
        return;
    }

    if ((r = utils.line(b, indata.line_s)) === false)
      return;
    else {
      m = RE_LITHEADER.exec(r);
      if (indata.line)
        indata.line += r;
      else
        indata.line = r;
      if (m)
        litType = m[1];
      indata.expect = (m ? parseInt(m[2], 10) : -1);
      if (indata.expect > -1) {
        /*if (RE_ISPARTIAL.test(litType))
          litType = litType.replace(RE_ISPARTIAL, '<$1.' + indata.expect + '>');*/
        if ((m = /\* (\d+) FETCH/i.exec(indata.line))
            && /^BODY\[/i.test(litType)) {
          msg = new ImapMessage();
          msg.seqno = parseInt(m[1], 10);
          fetches = requests[0].fetchers[litType];
          emitLitMsg(litType, msg);
          
          requests[0].key = litType;
          indata.streaming = !RE_ISHEADER.test(litType);
          if (indata.streaming)
            indata.literals.push(indata.expect);
        } else if (indata.expect === 0)
          indata.literals.push('');
        // start reading of the literal or get the rest of the response
        return ondata(b);
      }
    }

    if (indata.line[0] === '*') { // Untagged server response
      var isUnsolicited =
        (requests[0] && requests[0].cmd === 'NOOP')
        || (state.isIdle && state.ext.idle.state === IDLE_READY);
      if (m = XRegExp.exec(indata.line, REX_UNRESPNUM)) {
        // m.type = response type (numeric-based)
        m.type = m.type.toUpperCase();
        self.debug&&self.debug('[parsing incoming] saw untagged ' + m.type);
        switch (m.type) {
          case 'FETCH':
            // m.info = message details
            var data, parsed, headers, f, lenf, body, lenb, msg, bodies,
                details, val;
            if (!isUnsolicited)
              bodies = parsers.parseFetchBodies(m.info, indata.literals);
            details = new ImapMessage();
            parsers.parseFetch(m.info, indata.literals, details);
            details.seqno = parseInt(m.num, 10);

            if (isUnsolicited)
              self.emit('msgupdate', details);
            else {
              if (requests[0].fetchers[''] !== undefined) {
                // account for non-body fetches
                if (bodies) {
                  bodies.push('');
                  bodies.push(null);
                } else
                  bodies = ['', null];
              }

              var shouldEmit;
              for (body = 0, lenb = bodies.length; body < lenb; body += 2) {
                fetches = requests[0].fetchers[bodies[body]];
                val = bodies[body + 1];
                for (var i=0, len=fetches.length; i<len; ++i) {
                  parsed = undefined;
                  if (shouldEmit = (!fetches[i]._msg))
                    fetches[i]._msg = new ImapMessage();

                  // copy message properties (uid, date, flags, etc)
                  for (var k = 0, keys = Object.keys(details), lenk = keys.length;
                       k < lenk; ++k)
                    fetches[i]._msg[keys[k]] = details[keys[k]];

                  if (shouldEmit)
                    fetches[i].emit('message', fetches[i]._msg);

                  if (typeof val === 'number') {
                    // we streamed a body, e.g. {3}\r\nfoo
                  } else {
                    // no body was streamed
                    if (typeof val === 'string') {
                      // a body was given as a quoted, non-literal string,
                      // e.g. "foo"
                      if (RE_ISHEADER.test(bodies[body])) {
                        var parsed, data, headers;
                        if (fetches[i]._parse) {
                          if (parsed === undefined)
                            parsed = parsers.parseHeaders(val);
                          headers = parsed;
                        } else {
                          if (data === undefined)
                            data = new Buffer(val, 'binary');
                          headers = data;
                        }
                        fetches[i]._msg.emit('headers', headers);
                      } else {
                        var data = new Buffer(val, 'binary');
                        fetches[i]._msg.emit('data', data);
                      }
                    }
                  }
                }
              }
              for (body = 0, lenb = bodies.length; body < lenb; body += 2)
                emitMsgEnd(bodies[body]);
            }
            break;
          case 'EXISTS':
            // mailbox total message count
            var prev = state.box.messages.total,
                now = parseInt(m.num, 10);
            state.box.messages.total = now;
            if (state.status !== STATES.BOXSELECTING && now > prev) {
              state.box.messages.new = now - prev;
              self.emit('mail', state.box.messages.new); // new mail
            }
            break;
          case 'RECENT':
            // messages marked with the \Recent flag (i.e. new messages)
            state.box.messages.new = parseInt(m.num, 10);
            break;
          case 'EXPUNGE':
            // confirms permanent deletion of a single message
            if (state.box.messages.total > 0)
              --state.box.messages.total;
            if (isUnsolicited)
              self.emit('deleted', parseInt(m.num, 10));
            break;
        }
      } else if (m = XRegExp.exec(indata.line, REX_UNRESPDATA)) {
        // m.type = response type (data)
        m.type = m.type.toUpperCase();
        self.debug&&self.debug('[parsing incoming] saw untagged ' + m.type);
        switch (m.type) {
          case 'NAMESPACE':
            // m.personal = personal namespaces (or null)
            // m.other = personal namespaces (or null)
            // m.shared = personal namespaces (or null)
            self.namespaces.personal =
                  parsers.parseNamespaces(m.personal, indata.literals);
            self.namespaces.other =
                  parsers.parseNamespaces(m.other, indata.literals);
            self.namespaces.shared =
                  parsers.parseNamespaces(m.shared, indata.literals);
            break;
          case 'FLAGS':
            // m.flags = list of 0+ flags
            m.flags = (m.flags
                       ? m.flags.split(' ')
                                .map(function(f) {
                                  return f.substr(1);
                                })
                       : []);
            if (state.status === STATES.BOXSELECTING)
              state.box.flags = m.flags;
            break;
          case 'LIST':
          case 'LSUB':
          case 'XLIST':
            // m.flags = list of 0+ flags
            // m.delimiter = mailbox delimiter (string or null)
            // m.mailbox = mailbox name (string)
            m.flags = (m.flags ? m.flags.toUpperCase().split(' ') : []);
            m.delimiter = parsers.convStr(m.delimiter, indata.literals);
            m.mailbox = utf7.decode(''+parsers.convStr(m.mailbox, indata.literals));
            if (self.delimiter === undefined)
              self.delimiter = parsers.convStr(m.delimiter, indata.literals);
            else {
              if (requests[0].cbargs.length === 0)
                requests[0].cbargs.push({});
              var box = {
                    attribs: m.flags.map(function(attr) {
                               return attr.substr(1);
                             }),
                    delimiter: m.delimiter,
                    children: null,
                    parent: null
                  },
                  name = m.mailbox,
                  curChildren = requests[0].cbargs[0];

              if (box.delimiter) {
                var path = name.split(box.delimiter).filter(utils.isNotEmpty),
                    parent = null;
                name = path.pop();
                for (i=0,len=path.length; i<len; i++) {
                  if (!curChildren[path[i]])
                    curChildren[path[i]] = {};
                  if (!curChildren[path[i]].children)
                    curChildren[path[i]].children = {};
                  parent = curChildren[path[i]];
                  curChildren = curChildren[path[i]].children;
                }
                box.parent = parent;
              }
              if (!curChildren[name])
                curChildren[name] = box;
            }
            break;
          case 'SEARCH':
          case 'SORT':
            // m.results = list of 0+ uid/seq numbers (undefined if none)
            requests[0].cbargs.push(m.results
                                    ? m.results.trim().split(' ')
                                    : []);
            break;
          case 'STATUS':
            // m.mailbox = mailbox name (string)
            // m.attributes = expression list (k=>v pairs) of mailbox attributes
            m.mailbox = utf7.decode(''+parsers.convStr(m.mailbox, indata.literals));
            var ret = {
              name: m.mailbox,
              uidvalidity: 0,
              messages: {
                total: 0,
                new: 0,
                unseen: undefined
              }
            };
            if (m.attributes) {
              m.attributes = parsers.parseExpr(m.attributes, indata.literals);
              for (i=0,len=m.attributes.length; i<len; ++i) {
                switch (m.attributes[i].toUpperCase()) {
                  case 'RECENT':
                    ret.messages.new = parseInt(m.attributes[++i], 10);
                  break;
                  case 'UNSEEN':
                    ret.messages.unseen = parseInt(m.attributes[++i], 10);
                  break;
                  case 'MESSAGES':
                    ret.messages.total = parseInt(m.attributes[++i], 10);
                  break;
                  case 'UIDVALIDITY':
                    ret.uidvalidity = parseInt(m.attributes[++i], 10);
                  break;
                }
              }
            }
            requests[0].cbargs.push(ret);
            break;
          case 'CAPABILITY':
            // m.capabilities = list of (1+) flags
            if (state.numCapRecvs < 2)
              ++state.numCapRecvs;
            self.capabilities = m.capabilities.toUpperCase().split(' ');
            break;
          case 'BYE':
            // m.code = resp-text-code
            // m.message = arbitrary message
            state.conn.end();
            break;
        }
      } else if (m = RE_UNRESP.exec(indata.line)) {
        // m[1]: response type
        // m[2]: resp-text-code
        // m[3]: message
        m[1] = m[1].toUpperCase();
        self.debug&&self.debug('[parsing incoming] saw untagged ' + m[1]);
        switch (m[1]) {
          case 'OK':
            var code = m[2];
            if (state.status === STATES.NOAUTH) {
              if (!state.isReady) {
                clearTimeout(state.tmrConn);
                state.isReady = true;
                state.conn.emit('ready');
              }
            } else if (/^ALERT$/i.test(code))
              self.emit('alert', m[3]);
            else if (state.status === STATES.BOXSELECTING) {
              if (m = /^UIDVALIDITY (\d+)/i.exec(code))
                state.box.uidvalidity = parseInt(m[1], 10);
              else if (m = /^UIDNEXT (\d+)/i.exec(code))
                state.box.uidnext = parseInt(m[1], 10);
              else if (m = /^PERMANENTFLAGS \((.*)\)/i.exec(code)) {
                var idx, permFlags, keywords;
                state.box.permFlags = permFlags = m[1].split(' ');
                if ((idx = state.box.permFlags.indexOf('\\*')) > -1) {
                  state.box.newKeywords = true;
                  permFlags.splice(idx, 1);
                }
                state.box.keywords = keywords = permFlags.filter(function(f) {
                                                  return (f[0] !== '\\');
                                                });
                for (i=0,len=keywords.length; i<len; ++i)
                  permFlags.splice(permFlags.indexOf(keywords[i]), 1);
                state.box.permFlags = permFlags.map(function(f) {
                                        return f.substr(1);
                                      });
              }
            } else if (state.status === STATES.BOXSELECTED) {
              if (m = /^UIDVALIDITY (\d+)/i.exec(code)) {
                state.box.uidvalidity = parseInt(m[1], 10);
                self.emit('uidvalidity', state.box.uidvalidity);
              }
            }
            break;
          case 'PREAUTH':
            state.status = STATES.AUTH;
            state.authenticated = true;
            if (state.numCapRecvs === 0)
              state.numCapRecvs = 1;
            break;
          case 'NO':
          case 'BAD':
            if (state.status === STATES.NOAUTH) {
              clearTimeout(state.tmrConn);
              var err = new Error('Received negative welcome (' + m[3] + ')');
              err.level = 'protocol';
              if (state.status === STATES.NOCONNECT)
                loginCb(err);
              else
                self.emit('error', err);
              state.conn.end();
            }
            break;
        }
      } else {
        self.debug&&self.debug(
            '[parsing incoming] saw unexpected untagged response: '
            + inspect(indata.line));
        assert(false);
      }
      indata.literals = [];
      indata.line = undefined;
      indata.temp = undefined;
      indata.streaming = false;
      indata.expect = -1;
      if (b.p < b.length)
        return ondata(b);
    } else if (indata.line[0] === 'A' || indata.line[0] === '+') {
      var line = indata.line;
      indata.literals = [];
      indata.line = undefined;
      indata.temp = undefined;
      indata.streaming = false;
      indata.expect = -1;
      self.debug&&self.debug(line[0] === 'A'
                             ? '[parsing incoming] saw tagged response'
                             : '[parsing incoming] saw continuation response');
      if (line[0] === '+' && state.ext.idle.state === IDLE_WAIT) {
        state.ext.idle.state = IDLE_READY;
        state.ext.idle.timeStarted = Date.now();
        return process.nextTick(function() { self._send(); });
      }

      var sendBox = false;
      clearTimeout(state.tmrKeepalive);

      if (state.status === STATES.BOXSELECTING) {
        if (/^A\d+ OK/i.test(line)) {
          sendBox = true;
          state.box.readOnly = (requests[0].cmd === 'EXAMINE');
          state.status = STATES.BOXSELECTED;
        } else {
          state.status = STATES.AUTH;
          self._resetBox();
        }
      }

      if (requests[0].cmd === 'RENAME') {
        if (state.box._newName) {
          state.box.name = state.box._newName;
          state.box._newName = undefined;
        }
        sendBox = true;
      }

      if (typeof requests[0].callback === 'function') {
        var err = null;
        var args = requests[0].cbargs,
            cmdstr = requests[0].cmdstr;
        if (line[0] === '+') {
          if (requests[0].cmd !== 'APPEND') {
            err = new Error('Unexpected continuation');
            err.level = 'protocol';
            err.type = 'continuation';
            err.request = cmdstr;
          } else
            return requests[0].callback();
        } else if (m = /^A\d+ (NO|BAD) (?:\[(.+)\] )?(.+)$/i.exec(line)) {
          // m[1]: error type
          // m[2]: resp-text-code
          // m[3]: message
          err = new Error(m[3]);
          err.level = 'protocol';
          err.type = 'failure';
          err.code = m[2];
          err.request = cmdstr;
        } else if (state.status === STATES.BOXSELECTED) {
          if (sendBox) // SELECT, EXAMINE, RENAME
            args.unshift(state.box);
          // According to RFC 3501, UID commands do not give errors for
          // non-existant user-supplied UIDs, so give the callback empty results
          // if we unexpectedly received no untagged responses.
          else if ((cmdstr.indexOf('UID FETCH') === 0
                    || cmdstr.indexOf('UID SEARCH') === 0
                    || cmdstr.indexOf('UID SORT') === 0
                   ) && args.length === 0)
            args.unshift([]);
        }
        args.unshift(err);
        requests[0].callback.apply(self, args);
      }

      var recentCmd = requests[0].cmdstr;
      requests.shift();
      if (requests.length === 0 && recentCmd !== 'LOGOUT') {
        if (state.status >= STATES.AUTH && self._serverSupports('IDLE')) {
          // According to RFC 2177, we should re-IDLE at least every 29
          // minutes to avoid disconnection by the server
          self._send('IDLE', undefined, true);
        }
        state.tmrKeepalive = setTimeout(function idleHandler() {
          if (state.isIdle) {
            if (state.ext.idle.state === IDLE_READY) {
              state.tmrKeepalive = setTimeout(idleHandler, state.tmoKeepalive);
              var timeDiff = Date.now() - state.ext.idle.timeStarted;
              if (timeDiff >= state.ext.idle.MAX_WAIT)
                self._send('IDLE', undefined, true); // restart IDLE
            } else if (!self._serverSupports('IDLE'))
              self._noop();
          }
        }, state.tmoKeepalive);
      } else
        process.nextTick(function() { self._send(); });

      state.isIdle = true;
    } else if (/^IDLE /i.test(indata.line)) {
      self.debug&&self.debug('[parsing incoming] saw IDLE');
      if (requests.length)
        process.nextTick(function() { self._send(); });
      state.isIdle = false;
      state.ext.idle.state = IDLE_NONE;
      state.ext.idle.timeStated = undefined;
      indata.line = undefined;
      if (state.ext.idle.reIDLE) {
        state.ext.idle.reIDLE = false;
        self._send('IDLE', undefined, true);
      }
    } else {
      // unknown response
      self.debug&&self.debug('[parsing incoming] saw unexpected response: '
                             + inspect(indata.line));
      assert(false);
    }
  }

  state.conn.connect(this._options.port, this._options.host);

  state.tmrConn = setTimeout(function() {
    state.conn.destroy();
    state.conn = undefined;
    var err = new Error('Connection timed out');
    err.level = 'timeout';
    loginCb(err);
  }, this._options.connTimeout);
};

ImapConnection.prototype.logout = function(cb) {
  var self = this;
  if (this._state.status >= STATES.NOAUTH) {
    this._send('LOGOUT', function(err) {
      self._state.conn.end();
      if (typeof cb === 'function')
        cb(err);
    });
    if (cb === true)
      this._state.conn.removeAllListeners();
  } else
    throw new Error('Not connected');
};

ImapConnection.prototype.openBox = function(name, readOnly, cb) {
  if (this._state.status < STATES.AUTH)
    throw new Error('Not connected or authenticated');
  if (this._state.status === STATES.BOXSELECTED)
    this._resetBox();
  if (cb === undefined) {
    cb = readOnly;
    readOnly = false;
  }

  name = ''+name;
  this._state.box.name = name;

  this._send((readOnly ? 'EXAMINE' : 'SELECT') + ' "'
             + utils.escape(utf7.encode(name)) + '"', cb);
};

// also deletes any messages in this box marked with \Deleted
ImapConnection.prototype.closeBox = function(cb) {
  var self = this;
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  this._send('CLOSE', function(err) {
    if (!err) {
      self._state.status = STATES.AUTH;
      self._resetBox();
    }
    cb(err);
  });
};

ImapConnection.prototype.status = function(boxName, cb) {
  if (this._state.status === STATES.BOXSELECTED
      && this._state.box.name === boxName)
    throw new Error('Not allowed to call status on the currently selected mailbox');

  var cmd = 'STATUS "';
  cmd += utils.escape(utf7.encode(''+boxName));
  cmd += '" (MESSAGES RECENT UNSEEN UIDVALIDITY)';

  this._send(cmd, cb);
};

ImapConnection.prototype.removeDeleted = function(cb) {
  this._send('EXPUNGE', cb);
};

ImapConnection.prototype.getBoxes = function(namespace, cb) {
  if (typeof namespace === 'function') {
    cb = namespace;
    namespace = '';
  }
  this._send((!this._serverSupports('XLIST') ? 'LIST' : 'XLIST')
             + ' "' + utils.escape(namespace) + '" "*"', cb);
};

ImapConnection.prototype.addBox = function(name, cb) {
  this._send('CREATE "' + utils.escape(utf7.encode(''+name)) + '"', cb);
};

ImapConnection.prototype.delBox = function(name, cb) {
  this._send('DELETE "' + utils.escape(utf7.encode(''+name)) + '"', cb);
};

ImapConnection.prototype.renameBox = function(oldname, newname, cb) {
  if (this._state.status === STATES.BOXSELECTED
      && oldname === this._state.box.name && oldname !== 'INBOX')
    this._state.box._newName = ''+oldname;

  var cmd = 'RENAME "';
  cmd += utils.escape(utf7.encode(''+oldname));
  cmd += '" "';
  cmd += utils.escape(utf7.encode(''+newname));
  cmd += '"';
  this._send(cmd, cb);
};

ImapConnection.prototype.append = function(data, options, cb) {
  if (typeof options === 'function') {
    cb = options;
    options = undefined;
  }
  options = options || {};
  if (!options.mailbox) {
    if (this._state.status !== STATES.BOXSELECTED)
      throw new Error('No mailbox specified or currently selected');
    else
      options.mailbox = this._state.box.name;
  }
  var cmd = 'APPEND "' + utils.escape(utf7.encode(''+options.mailbox)) + '"';
  if (options.flags) {
    if (!Array.isArray(options.flags))
      options.flags = [options.flags];
    cmd += " (\\" + options.flags.join(' \\') + ")";
  }
  if (options.date) {
    if (!isDate(options.date))
      throw new Error("`date` isn't a Date object");
    cmd += ' "';
    cmd += options.date.getDate();
    cmd += '-';
    cmd += utils.MONTHS[options.date.getMonth()];
    cmd += '-';
    cmd += options.date.getFullYear();
    cmd += ' ';
    cmd += ('0' + options.date.getHours()).slice(-2);
    cmd += ':';
    cmd += ('0' + options.date.getMinutes()).slice(-2);
    cmd += ':';
    cmd += ('0' + options.date.getSeconds()).slice(-2);
    cmd += ((options.date.getTimezoneOffset() > 0) ? ' -' : ' +' );
    cmd += ('0' + (-options.date.getTimezoneOffset() / 60)).slice(-2);
    cmd += ('0' + (-options.date.getTimezoneOffset() % 60)).slice(-2);
    cmd += '"';
  }
  cmd += ' {';
  cmd += (Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data));
  cmd += '}';
  var self = this, step = 1;
  this._send(cmd, function(err) {
    if (err || step++ === 2)
      return cb(err);
    self._state.conn.write(data);
    self._state.conn.write(CRLF);
    self.debug&&self.debug('\n==> ' + inspect(data.toString()) + '\n');
  });
};

ImapConnection.prototype.search = function(options, cb) {
  this._search('UID ', options, cb);
};

ImapConnection.prototype._search = function(which, options, cb) {
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  if (!Array.isArray(options))
    throw new Error('Expected array for search options');
  this._send(which + 'SEARCH'
             + utils.buildSearchQuery(options, this.capabilities), cb);
};

ImapConnection.prototype.sort = function(sorts, options, cb) {
  this._sort('UID ', sorts, options, cb);
};

ImapConnection.prototype._sort = function(which, sorts, options, cb) {
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  if (!Array.isArray(sorts) || !sorts.length)
    throw new Error('Expected array with at least one sort criteria');
  if (!Array.isArray(options))
    throw new Error('Expected array for search options');
  if (!this._serverSupports('SORT'))
    return cb(new Error('Sorting is not supported on the server'));

  var criteria = sorts.map(function(criterion) {
    if (typeof criterion !== 'string')
      throw new Error('Unexpected sort criterion data type. '
                      + 'Expected string. Got: ' + typeof criteria);

    var modifier = '';
    if (criterion[0] === '-') {
      modifier = 'REVERSE ';
      criterion = criterion.substring(1);
    }
    switch (criterion.toUpperCase()) {
      case 'ARRIVAL':
      case 'CC':
      case 'DATE':
      case 'FROM':
      case 'SIZE':
      case 'SUBJECT':
      case 'TO':
        break;
      default:
        throw new Error('Unexpected sort criteria: ' + criterion);
    }

    return modifier + criterion;
  });

  this._send(which + 'SORT (' + criteria.join(' ') + ') UTF-8'
             + utils.buildSearchQuery(options, this.capabilities), cb);
};

ImapConnection.prototype.fetch = function(uids, options, what, cb) {
  return this._fetch('UID ', uids, options, what, cb);
};

ImapConnection.prototype._fetch = function(which, uids, options, what, cb) {
  if (uids === undefined
      || uids === null
      || (Array.isArray(uids) && uids.length === 0))
    throw new Error('Nothing to fetch');

  if (!Array.isArray(uids))
    uids = [uids];
  utils.validateUIDList(uids);

  var toFetch = '', prefix = ' BODY[', extensions, self = this,
      parse, headers, key, stream,
      fetchers = {};

  // argument detection!
  if (cb === undefined) {
    // fetch(uids, xxxx, yyyy)
    if (what === undefined) {
      // fetch(uids, xxxx)
      if (options === undefined) {
        // fetch(uids)
        what = options = {};
      } else if (typeof options === 'function') {
        // fetch(uids, callback)
        cb = options;
        what = options = {};
      } else if (options.struct !== undefined
               || options.size !== undefined
               || options.markSeen !== undefined) {
        // fetch(uids, options)
        what = {};
      } else {
        // fetch(uids, what)
        what = options;
        options = {};
      }
    } else if (typeof what === 'function') {
      // fetch(uids, xxxx, callback)
      cb = what;
      if (options.struct !== undefined
          || options.size !== undefined
          || options.markSeen !== undefined) {
        // fetch(uids, options, callback)
        what = {};
      } else {
        // fetch(uids, what, callback)
        what = options;
        options = {};
      }
    }
  }

  if (!Array.isArray(what))
    what = [what];

  for (var i = 0, wp, pprefix, len = what.length; i < len; ++i) {
    wp = what[i];
    parse = true;
    if (wp.id !== undefined && !/^(?:[\d]+[\.]{0,1})*[\d]+$/.test(''+wp.id))
      throw new Error('Invalid part id: ' + wp.id);
    if (( (wp.headers
           && (!wp.headers.fields
               || (Array.isArray(wp.headers.fields)
                   && wp.headers.fields.length === 0)
              )
           && wp.headers.parse === false
          )
          ||
          (wp.headersNot
           && (!wp.headersNot.fields
               || (Array.isArray(wp.headersNot.fields)
                   && wp.headersNot.fields.length === 0)
              )
           && wp.headersNot.parse === false
          )
        )
        && wp.body === true) {
      key = prefix.trim();
      if (wp.id !== undefined)
        key += wp.id;
      key += ']';
      if (!fetchers[key]) {
        fetchers[key] = [new ImapFetch()];
        toFetch += ' ';
        toFetch += key;
      }
      if (typeof wp.cb === 'function')
        wp.cb(fetchers[key][0]);
      key = undefined;
    } else if (wp.headers || wp.headersNot || wp.body) {
      pprefix = prefix;
      if (wp.id !== undefined) {
        pprefix += wp.id;
        pprefix += '.';
      }
      if (wp.headers) {
        key = pprefix.trim();
        if (wp.headers === true)
          key += 'HEADER]';
        else {
          if (Array.isArray(wp.headers))
            headers = wp.headers;
          else if (typeof wp.headers === 'string')
            headers = [wp.headers];
          else if (typeof wp.headers === 'object') {
            if (wp.headers.fields === undefined)
              wp.headers.fields = true;
            if (!Array.isArray(wp.headers.fields)
                && typeof wp.headers.fields !== 'string'
                && wp.headers.fields !== true)
              throw new Error('Invalid `fields` property');
            if (Array.isArray(wp.headers.fields))
              headers = wp.headers.fields;
            else if (wp.headers.fields === true)
              headers = true;
            else
              headers = [wp.headers.fields];
            if (wp.headers.parse === false)
              parse = false;
          } else
            throw new Error('Invalid `headers` value: ' + wp.headers);
          if (headers === true)
            key += 'HEADER]';
          else {
            key += 'HEADER.FIELDS (';
            key += headers.join(' ').toUpperCase();
            key += ')]';
          }
        }
      } else if (wp.headersNot) {
        key = pprefix.trim();
        if (wp.headersNot === true)
          key += 'HEADER]';
        else {
          if (Array.isArray(wp.headersNot))
            headers = wp.headersNot;
          else if (typeof wp.headersNot === 'string')
            headers = [wp.headersNot];
          else if (typeof wp.headersNot === 'object') {
            if (wp.headersNot.fields === undefined)
              wp.headersNot.fields = true;
            if (!Array.isArray(wp.headersNot.fields)
                && typeof wp.headersNot.fields !== 'string'
                && wp.headersNot.fields !== true)
              throw new Error('Invalid `fields` property');
            if (Array.isArray(wp.headersNot.fields))
              headers = wp.headersNot.fields;
            else if (wp.headersNot.fields)
              headers = true;
            else
              headers = [wp.headersNot.fields];
            if (wp.headersNot.parse === false)
              parse = false;
          } else
            throw new Error('Invalid `headersNot` value: ' + wp.headersNot);
          if (headers === true)
            key += 'HEADER]';
          else {
            key += 'HEADER.FIELDS.NOT (';
            key += headers.join(' ').toUpperCase();
            key += ')]';
          }
        }
      }
      if (key) {
        stream = new ImapFetch();
        if (parse)
          stream._parse = true;
        if (!fetchers[key]) {
          fetchers[key] = [stream];
          toFetch += ' ';
          toFetch += key;
        } else
          fetchers[key].push(stream);
        if (typeof wp.cb === 'function')
          wp.cb(stream);
        key = undefined;
      }
      if (wp.body) {
        key = pprefix;
        if (wp.body === true)
          key += 'TEXT]';
        /*else if (typeof wp.body.start === 'number'
                   && typeof wp.body.length === 'number') {
          if (wp.body.start < 0)
            throw new Error('Invalid `start` value: ' + wp.body.start);
          else if (wp.body.length <= 0)
            throw new Error('Invalid `length` value: ' + wp.body.length);
          key += 'TEXT]<';
          key += wp.body.start;
          key += '.';
          key += wp.body.length;
          key += '>';
        }*/ else
          throw new Error('Invalid `body` value: ' + wp.body);

        key = key.trim();
        if (!stream)
          stream = new ImapFetch();
        if (!fetchers[key]) {
          fetchers[key] = [stream];
          toFetch += ' ' + key;
        } else
          fetchers[key].push(stream);
        if (!wp.headers && !wp.headersNot && typeof wp.cb === 'function')
          wp.cb(stream);
        stream = undefined;
        key = undefined;
      }
    } else {
      // non-body fetches
      stream = new ImapFetch();
      if (fetchers[''])
        fetchers[''].push(stream);
      else
        fetchers[''] = [stream];
      if (typeof wp.cb === 'function')
        wp.cb(stream);
    }
  }

  // always fetch GMail-specific bits of information when on GMail
  if (this._serverSupports('X-GM-EXT-1'))
    extensions = 'X-GM-THRID X-GM-MSGID X-GM-LABELS ';

  var cmd = which;
  cmd += 'FETCH ';
  cmd += uids.join(',');
  cmd += ' (';
  if (extensions)
    cmd += extensions;
  cmd += 'UID FLAGS INTERNALDATE';
  if (options.struct)
    cmd += ' BODYSTRUCTURE';
  if (options.size)
    cmd += ' RFC822.SIZE';
  if (toFetch) {
    if (!options.markSeen)
      cmd += toFetch.replace(/BODY\[/g, 'BODY.PEEK[');
    else
      cmd += toFetch;
  }
  cmd += ')';

  this._send(cmd, function(err) {
    var keys = Object.keys(fetchers), k, lenk = keys.length, f, lenf,
        fetches;
    if (err) {
      for (k = 0; k < lenk; ++k) {
        fetches = fetchers[keys[k]];
        for (f = 0, lenf = fetches.length; f < lenf; ++f)
          fetches[f].emit('error', err);
      }
    }
    for (k = 0; k < lenk; ++k) {
      fetches = fetchers[keys[k]];
      for (f = 0, lenf = fetches.length; f < lenf; ++f)
        fetches[f].emit('end');
    }
    cb&&cb(err);
  });

  this._state.requests[this._state.requests.length - 1].fetchers = fetchers;
};

ImapConnection.prototype.addFlags = function(uids, flags, cb) {
  this._store('UID ', uids, flags, true, cb);
};

ImapConnection.prototype.delFlags = function(uids, flags, cb) {
  this._store('UID ', uids, flags, false, cb);
};

ImapConnection.prototype.addKeywords = function(uids, flags, cb) {
  return this._addKeywords('UID ', uids, flags, cb);
};

ImapConnection.prototype._addKeywords = function(which, uids, flags, cb) {
  if (!this._state.box.newKeywords)
    throw new Error('This mailbox does not allow new keywords to be added');
  this._store(which, uids, flags, true, cb);
};

ImapConnection.prototype.delKeywords = function(uids, flags, cb) {
  this._store('UID ', uids, flags, false, cb);
};

ImapConnection.prototype.setLabels = function(uids, labels, cb) {
    this._storeLabels('UID ', uids, labels, '', cb);
};

ImapConnection.prototype.addLabels = function(uids, labels, cb) {
    this._storeLabels('UID ', uids, labels, '+', cb);
};

ImapConnection.prototype.delLabels = function(uids, labels, cb) {
    this._storeLabels('UID ', uids, labels, '-', cb);
};

ImapConnection.prototype._storeLabels = function(which, uids, labels, mode, cb) {
  if (!this._serverSupports('X-GM-EXT-1'))
      throw new Error('Server must support X-GM-EXT-1 capability');
  if (this._state.status !== STATES.BOXSELECTED)
      throw new Error('No mailbox is currently selected');
  if (uids === undefined)
      throw new Error('The message ID(s) must be specified');

  if (!Array.isArray(uids))
      uids = [uids];
  utils.validateUIDList(uids);

  if ((!Array.isArray(labels) && typeof labels !== 'string')
      || (Array.isArray(labels) && labels.length === 0))
      throw new Error('labels argument must be a string or a non-empty Array');
  if (!Array.isArray(labels))
      labels = [labels];
  labels = labels.join(' ');

  this._send(which + 'STORE ' + uids.join(',') + ' ' + mode
             + 'X-GM-LABELS.SILENT (' + labels + ')', cb);
};

ImapConnection.prototype.copy = function(uids, boxTo, cb) {
  return this._copy('UID ', uids, boxTo, cb);
};

ImapConnection.prototype._copy = function(which, uids, boxTo, cb) {
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');

  if (!Array.isArray(uids))
    uids = [uids];

  utils.validateUIDList(uids);

  this._send(which + 'COPY ' + uids.join(',') + ' "'
             + utils.escape(utf7.encode(''+boxTo)) + '"', cb);
};

ImapConnection.prototype.move = function(uids, boxTo, cb) {
  return this._move('UID ', uids, boxTo, cb);
};

ImapConnection.prototype._move = function(which, uids, boxTo, cb) {
  var self = this;
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  if (this._state.box.permFlags.indexOf('Deleted') === -1) {
    throw new Error('Cannot move message: '
                    + 'server does not allow deletion of messages');
  } else {
    this._copy(which, uids, boxTo, function ccb(err, reentryCount, deletedUIDs,
                                                counter) {
      if (err)
        return cb(err);

      counter = counter || 0;
      // Make sure we don't expunge any messages marked as Deleted except the
      // one we are moving
      if (reentryCount === undefined) {
        self.search(['DELETED'], function(e, result) {
          ccb(e, 1, result);
        });
      } else if (reentryCount === 1) {
        if (counter < deletedUIDs.length) {
          self.delFlags(deletedUIDs[counter], 'Deleted', function(e) {
            process.nextTick(function() {
              ccb(e, reentryCount, deletedUIDs, counter + 1);
            });
          });
        } else
          ccb(err, reentryCount + 1, deletedUIDs);
      } else if (reentryCount === 2) {
        self.addFlags(uids, 'Deleted', function(e) {
          ccb(e, reentryCount + 1, deletedUIDs);
        });
      } else if (reentryCount === 3) {
        self.removeDeleted(function(e) {
          ccb(e, reentryCount + 1, deletedUIDs);
        });
      } else if (reentryCount === 4) {
        if (counter < deletedUIDs.length) {
          self.addFlags(deletedUIDs[counter], 'Deleted', function(e) {
            process.nextTick(function() {
              ccb(e, reentryCount, deletedUIDs, counter + 1);
            });
          });
        } else
          cb();
      }
    });
  }
};

// Namespace for seqno-based commands
ImapConnection.prototype.__defineGetter__('seq', function() {
  var self = this;
  return {
    move: function(seqnos, boxTo, cb) {
      return self._move('', seqnos, boxTo, cb);
    },
    copy: function(seqnos, boxTo, cb) {
      return self._copy('', seqnos, boxTo, cb);
    },
    delKeywords: function(seqnos, flags, cb) {
      self._store('', seqnos, flags, false, cb);
    },
    addKeywords: function(seqnos, flags, cb) {
      return self._addKeywords('', seqnos, flags, cb);
    },
    delFlags: function(seqnos, flags, cb) {
      self._store('', seqnos, flags, false, cb);
    },
    addFlags: function(seqnos, flags, cb) {
      self._store('', seqnos, flags, true, cb);
    },
    delLabels: function(seqnos, labels, cb) {
      self._storeLabels('', seqnos, labels, '-', cb);
    },
    addLabels: function(seqnos, labels, cb) {
      self._storeLabels('', seqnos, labels, '+', cb);
    },
    setLabels: function(seqnos, labels, cb) {
      self._storeLabels('', seqnos, labels, '', cb);
    },
    fetch: function(seqnos, options, what, cb) {
      return self._fetch('', seqnos, options, what, cb);
    },
    search: function(options, cb) {
      self._search('', options, cb);
    },
    sort: function(sorts, options, cb) {
      self._sort('', sorts, options, cb);
    }
  };
});


// Private/Internal Functions
ImapConnection.prototype._serverSupports = function(capability) {
  return (this.capabilities.indexOf(capability) > -1);
};

ImapConnection.prototype._store = function(which, uids, flags, isAdding, cb) {
  var isKeywords = (arguments.callee.caller === this._addKeywords
                    || arguments.callee.caller === this.delKeywords);
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  if (uids === undefined)
    throw new Error('The message ID(s) must be specified');

  if (!Array.isArray(uids))
    uids = [uids];
  utils.validateUIDList(uids);

  if ((!Array.isArray(flags) && typeof flags !== 'string')
      || (Array.isArray(flags) && flags.length === 0))
    throw new Error((isKeywords ? 'Keywords' : 'Flags')
                    + ' argument must be a string or a non-empty Array');
  if (!Array.isArray(flags))
    flags = [flags];
  for (var i=0; i<flags.length; i++) {
    if (!isKeywords) {
      if (flags[i][0] === '\\')
        flags[i] = flags[i].substr(1);
      if (this._state.box.permFlags.indexOf(flags[i]) === -1
          || flags[i] === '*')
        throw new Error('The flag "' + flags[i]
                        + '" is not allowed by the server for this mailbox');
      flags[i] = '\\' + flags[i];
    } else {
      // keyword contains any char except control characters (%x00-1F and %x7F)
      // and: '(', ')', '{', ' ', '%', '*', '\', '"', ']'
      if (/[\(\)\{\\\"\]\%\*\x00-\x20\x7F]/.test(flags[i])) {
        throw new Error('The keyword "' + flags[i]
                        + '" contains invalid characters');
      }
    }
  }
  flags = flags.join(' ');

  this._send(which + 'STORE ' + uids.join(',') + ' ' + (isAdding ? '+' : '-')
             + 'FLAGS.SILENT (' + flags + ')', cb);
};

ImapConnection.prototype._login = function(cb) {
  var self = this,
      fnReturn = function(err) {
        if (!err) {
          self._state.status = STATES.AUTH;
          self._state.authenticated = true;
          if (self._state.numCapRecvs !== 2) {
            // fetch post-auth server capabilities if they were not
            // automatically provided after login
            self._send('CAPABILITY', cb);
            return;
          }
        }
        cb(err);
      };

  if (this._state.status === STATES.NOAUTH) {
    if (this._serverSupports('LOGINDISABLED'))
      return cb(new Error('Logging in is disabled on this server'));

    if (this._serverSupports('AUTH=XOAUTH') && this._options.xoauth) {
      this._send('AUTHENTICATE XOAUTH ' + utils.escape(this._options.xoauth),
                 fnReturn);
    } else if (this._serverSupports('AUTH=XOAUTH2') && this._options.xoauth2) {
      this._send('AUTHENTICATE XOAUTH2 ' + utils.escape(this._options.xoauth2),
                 fnReturn);
    } else if (this._options.username !== undefined
               && this._options.password !== undefined) {
      this._send('LOGIN "' + utils.escape(this._options.username) + '" "'
                 + utils.escape(this._options.password) + '"', fnReturn);
    } else {
      return cb(new Error('No supported authentication method(s) available. '
                          + 'Unable to login.'));
    }
  }
};

ImapConnection.prototype._reset = function() {
  clearTimeout(this._state.tmrKeepalive);
  clearTimeout(this._state.tmrConn);
  this._state.status = STATES.NOCONNECT;
  this._state.curId = 0;
  this._state.requests = [];
  this._state.numCapRecvs = 0;
  this._state.isReady = false;
  this._state.isIdle = true;
  this._state.tmrKeepalive = null;
  this._state.tmrConn = null;
  this._state.ext.idle.state = IDLE_NONE;
  this._state.ext.idle.timeStarted = undefined;
  this._state.ext.idle.reIDLE = false;

  this._state.indata.literals = [];
  this._state.indata.line = undefined;
  this._state.indata.line_s.p = 0;
  this._state.indata.line_s.ret = undefined;
  this._state.indata.temp = undefined;
  this._state.indata.streaming = false;
  this._state.indata.expect = -1;

  this.namespaces = { personal: [], other: [], shared: [] };
  this.delimiter = undefined;
  this.capabilities = [];

  this._resetBox();
};

ImapConnection.prototype._resetBox = function() {
  this._state.box.uidnext = 0;
  this._state.box.readOnly = false;
  this._state.box.flags = [];
  this._state.box.newKeywords = false;
  this._state.box.uidvalidity = 0;
  this._state.box.permFlags = [];
  this._state.box.keywords = [];
  this._state.box.name = undefined;
  this._state.box._newName = undefined;
  this._state.box.messages.total = 0;
  this._state.box.messages.new = 0;
};

ImapConnection.prototype._noop = function() {
  if (this._state.status >= STATES.AUTH)
    this._send('NOOP');
};

ImapConnection.prototype._send = function(cmdstr, cb, bypass) {
  if (cmdstr !== undefined && !bypass) {
    this._state.requests.push({
      cmd: cmdstr.match(RE_CMD)[1],
      cmdstr: cmdstr,
      callback: cb,
      cbargs: []
    });
  }
  if (this._state.ext.idle.state === IDLE_WAIT
      || (this._state.ext.idle.state === IDLE_DONE && cmdstr !== 'DONE'))
    return;
  if ((cmdstr === undefined && this._state.requests.length)
      || this._state.requests.length === 1 || bypass) {
    var prefix = '',
        cmd = (bypass ? cmdstr : this._state.requests[0].cmdstr);
    clearTimeout(this._state.tmrKeepalive);
    if (this._state.ext.idle.state === IDLE_READY && cmd !== 'DONE') {
      this._state.ext.idle.state = IDLE_DONE;
      if (cmd === 'IDLE')
        this._state.ext.idle.reIDLE = true;
      return this._send('DONE', undefined, true);
    } else if (cmd === 'IDLE') {
       // we use a different prefix to differentiate and disregard the tagged
       // response the server will send us when we issue DONE
      prefix = 'IDLE ';
      this._state.ext.idle.state = IDLE_WAIT;
    }
    if (cmd !== 'IDLE' && cmd !== 'DONE')
      prefix = 'A' + (++this._state.curId) + ' ';
    this._state.conn.write(prefix);
    this._state.conn.write(cmd);
    this._state.conn.write(CRLF);
    this.debug&&this.debug('\n==> ' + prefix + cmd + '\n');
    if (this._state.requests[0]
        && (this._state.requests[0].cmd === 'EXAMINE'
            || this._state.requests[0].cmd === 'SELECT'))
      this._state.status = STATES.BOXSELECTING;
  }
};

function ImapMessage() {
  this.seqno = undefined;
  this.uid = undefined;
  this.flags = undefined;
  this.date = undefined;
  this.structure = undefined;
  this.size = undefined;
}
inherits(ImapMessage, EventEmitter);

function ImapFetch() {
  this._parse = false;
}
inherits(ImapFetch, EventEmitter);
