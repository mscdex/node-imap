var util = require('util'),
    Socket = require('net').Socket,
    EventEmitter = require('events').EventEmitter,
    MIMEParser = require('./mimeparser');

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
    BOX_ATTRIBS = ['NOINFERIORS', 'NOSELECT', 'MARKED', 'UNMARKED'],
    REGEXP_FETCH = /^\* (\d+) FETCH .+? \{(\d+)\}\r\n/;

// extension constants
var IDLE_NONE = 1,
    IDLE_WAIT = 2,
    IDLE_READY = 3;

function ImapConnection (options) {
  if (!(this instanceof ImapConnection))
    return new ImapConnection(options);
  EventEmitter.call(this);

  this._options = {
    username: '',
    password: '',
    host: 'localhost',
    port: 143,
    secure: false,
    connTimeout: 10000, // connection timeout in msecs
    debug: false
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
    curData: null,
    curExpected: 0,
    curXferred: 0,
    box: {
      _uidnext: 0,
      _flags: [],
      _newKeywords: false,
      validity: 0,
      keywords: [],
      permFlags: [],
      name: null,
      messages: { total: 0, new: 0 }
    },
    ext: {
      // Capability-specific state info
      idle: {
        MAX_WAIT: 1740000, // 29 mins in ms
        state: IDLE_NONE,
        timeWaited: 0 // ms
      }
    }
  };
  this._options = utils.extend(true, this._options, options);

  if (typeof this._options.debug === 'function')
    this.debug = this._options.debug;
  else
    this.debug = false;
  this.delim = null;
  this.namespaces = { personal: [], other: [], shared: [] };
  this.capabilities = [];
};

util.inherits(ImapConnection, EventEmitter);
exports.ImapConnection = ImapConnection;

ImapConnection.prototype.connect = function(loginCb) {
  var self = this;

  this._reset();

  this._state.conn = new Socket();
  this._state.conn.setKeepAlive(true);

  if (this._options.secure) {
    // TODO: support STARTTLS
    this._state.conn.cleartext = utils.setSecure(this._state.conn);
    this._state.conn.on('secure', function() {
      self.debug&&self.debug('Secure connection made.');
    });
  } else
    this._state.conn.cleartext = this._state.conn;

  this._state.conn.on('connect', function() {
    clearTimeout(self._state.tmrConn);
    self.debug&&self.debug('Connected to host.');
    self._state.conn.cleartext.write('');
    self._state.status = STATES.NOAUTH;
  });

  this._state.conn.on('end', function() {
    self._reset();
    self.debug&&self.debug('FIN packet received. Disconnecting...');
    self.emit('end');
  });

  function errorHandler(err) {
    clearTimeout(self._state.tmrConn);
    if (self._state.status === STATES.NOCONNECT)
      loginCb(new Error('Unable to connect. Reason: ' + err));
    self.emit('error', err);
    self.debug&&self.debug('Error occurred: ' + err);
  }

  this._state.conn.cleartext.on('error', errorHandler);

  this._state.conn.on('close', function(had_error) {
    self._reset();
    self.debug&&self.debug('Connection forcefully closed.');
    self.emit('close', had_error);
  });

  this._state.conn.on('ready', function() {
    // First get pre-auth capabilities, including server-supported auth
    // mechanisms
    self._send('CAPABILITY', function() {
      // Next, attempt to login
      var checkedNS = false;
      self._login(function redo(err) {
        if (err)
          return loginCb(err);
        // Next, get the list of available namespaces if supported (RFC2342)
        if (!checkedNS && self._serverSupports('NAMESPACE')) {
          // Re-enter this function after we've obtained the available
          // namespaces
          checkedNS = true;
          return self._send('NAMESPACE', redo);
        }
        // Lastly, get the top-level mailbox hierarchy delimiter used by the
        // server
        self._send('LIST "" ""', loginCb);
      });
    });
  });

  this._state.conn.cleartext.on('data', function(data) {
    if (data.length === 0) return;
    var literalInfo;
    self.debug&&self.debug('\nSERVER: ' + util.inspect(data.toString()) + '\n');

    if (self._state.curExpected === 0) {
      if (utils.bufferIndexOf(data, CRLF) === -1) {
        if (self._state.curData)
          self._state.curData = utils.bufferAppend(self._state.curData, data);
        else
          self._state.curData = data;
        return;
      }
      if (self._state.curData && self._state.curData.length) {
        data = utils.bufferAppend(self._state.curData, data);
        self._state.curData = null;
      }
    }

    // Don't mess with incoming data if it's part of a literal
    var strdata;
    if (self._state.curExpected > 0) {
      var curReq = self._state.requests[0];

      if (!curReq._done) {
        var chunk = data;
        self._state.curXferred += data.length;
        if (self._state.curXferred > self._state.curExpected) {
          var pos = data.length
                    - (self._state.curXferred - self._state.curExpected),
              extra = data.slice(pos);
          if (pos > 0)
            chunk = data.slice(0, pos);
          else
            chunk = undefined;
          data = extra;
          curReq._done = 1;
        }

        if (chunk && chunk.length) {
          if (curReq._useParser)
            self._state.parser.execute(chunk);
          else
            curReq._msg.emit('data', chunk);
        }
      }
      if (curReq._done) {
        var restDesc;
        if (curReq._done === 1) {
          if (curReq._useParser)
            self._state.parser.finish();
          self._state.curData = null;
          curReq._done = true;
        }

        if (self._state.curData)
          self._state.curData = utils.bufferAppend(self._state.curData, data);
        else
          self._state.curData = data;

        if (restDesc = self._state.curData.toString().match(/^(.*?)\)\r\n/)) {
          if (restDesc[1]) {
            restDesc[1] = restDesc[1].trim();
            if (restDesc[1].length)
              restDesc[1] = ' ' + restDesc[1];
          } else
            restDesc[1] = '';
          parsers.parseFetch(curReq._desc + restDesc[1], curReq._msg);
          var curData = self._state.curData;
          data = curData.slice(utils.bufferIndexOf(curData, CRLF) + 2);
          curReq._done = false;
          self._state.curXferred = 0;
          self._state.curExpected = 0;
          self._state.curData = null;
          curReq._msg.emit('end');
          if (data.length && data[0] === 42/* '*' */) {
            self._state.conn.cleartext.emit('data', data);
            return;
          }
        } else
          return;
      } else
        return;
    } else if (self._state.curExpected === 0 &&
               (literalInfo = (strdata = data.toString()).match(REGEXP_FETCH))) {
      self._state.curExpected = parseInt(literalInfo[2], 10);
      var idxCRLF = strdata.indexOf(CRLF),
          curReq = self._state.requests[0],
          type = /BODY\[(.*)\](?:\<\d+\>)?/.exec(strdata.substring(0, idxCRLF)),
          msg = new ImapMessage(),
          desc = strdata.substring(strdata.indexOf('(') + 1, idxCRLF).trim();
      msg.seqno = parseInt(literalInfo[1], 10);
      type = type[1];
      curReq._desc = desc;
      curReq._msg = msg;
      curReq._fetcher.emit('message', msg);
      if (curReq._useParser) {
        curReq._msg.headers = {};
        if (!self._state.parser) {
          self._state.parser = new MIMEParser();
          self._state.parser.on('header', function(name, val) {
            name = name.toLowerCase();
            if (self._state.requests[0]._msg.headers[name] !== undefined)
              self._state.requests[0]._msg.headers[name].push(val);
            else
              self._state.requests[0]._msg.headers[name] = [val];
          });
          self._state.parser.on('data', function(str) {
            self._state.requests[0]._msg.emit('data', str);
          });
        }
      }
      return self._state.conn.cleartext.emit('data', data.slice(idxCRLF + 2));
    }

    if (data.length === 0) return;

    var endsInCRLF = (data[data.length-2] === 13 && data[data.length-1] === 10);
    data = utils.bufferSplit(data, CRLF);

    // Defer any extra server responses found in the incoming data
    if (data.length > 1) {
      for (var i=1,len=data.length; i<len; ++i) {
        (function(line, isLast) {
          process.nextTick(function() {
            var needsCRLF = !isLast || (isLast && endsInCRLF),
                b = new Buffer(needsCRLF ? line.length + 2 : line.length);
            line.copy(b, 0, 0);
            if (needsCRLF) {
              b[b.length - 2] = 13;
              b[b.length - 1] = 10;
            }
            self._state.conn.cleartext.emit('data', b);
          });
        })(data[i], i === len - 1);
      }
    }

    data = utils.explode(data[0].toString(), ' ', 3);

    if (data[0] === '*') { // Untagged server response
      if (self._state.status === STATES.NOAUTH) {
        if (data[1] === 'PREAUTH') { // the server pre-authenticated us
          self._state.status = STATES.AUTH;
          if (self._state.numCapRecvs === 0)
            self._state.numCapRecvs = 1;
        } else if (data[1] === 'NO' || data[1] === 'BAD' || data[1] === 'BYE')
          return self._state.conn.end();
        if (!self._state.isReady) {
          self._state.isReady = true;
          self._state.conn.emit('ready');
        }
        // Restrict the type of server responses when unauthenticated
        if (data[1] !== 'CAPABILITY' && data[1] !== 'ALERT') return;
      }
      switch (data[1]) {
        case 'CAPABILITY':
          if (self._state.numCapRecvs < 2)
            self._state.numCapRecvs++;
          self.capabilities = data[2].split(' ')
                                     .map(function(s) {
                                      return s.toUpperCase();
                                     });
        break;
        case 'FLAGS':
          if (self._state.status === STATES.BOXSELECTING) {
            self._state.box._flags = data[2].substr(1, data[2].length - 2)
                                            .split(' ')
                                            .map(function(flag) {
                                              return flag.substr(1);
                                            });
          }
        break;
        case 'STATUS':
          var result = parsers.parseExpr(data[2]),
              values = result[1],
              ret = {
                name: result[0],
                validity: undefined,
                messages: {
                  total: undefined,
                  new: undefined
                }
              };
          for (var i=0,len=values.length; i<len; i+=2) {
            switch (values[i].toLowerCase()) {
              case 'recent':
                ret.messages.new = parseInt(values[i + 1], 10);
              break;
              case 'messages':
                ret.messages.total = parseInt(values[i + 1], 10);
              break;
              case 'uidvalidity':
                ret.validity = parseInt(values[i + 1], 10);
              break;
            }
          }
          self._state.requests[0].args.push(ret);
        break;
        case 'OK':
          if (result = /^\[ALERT\] (.*)$/i.exec(data[2]))
            self.emit('alert', result[1]);
          else if (self._state.status === STATES.BOXSELECTING) {
            var result;
            if (result = /^\[UIDVALIDITY (\d+)\]/i.exec(data[2]))
              self._state.box.validity = result[1];
            else if (result = /^\[UIDNEXT (\d+)\]/i.exec(data[2]))
              self._state.box._uidnext = result[1];
            else if (result = /^\[PERMANENTFLAGS \((.*)\)\]/i.exec(data[2])) {
              var idx, permFlags, keywords;
              self._state.box.permFlags = permFlags = result[1].split(' ');
              if ((idx = self._state.box.permFlags.indexOf('\\*')) > -1) {
                self._state.box._newKeywords = true;
                permFlags.splice(idx, 1);
              }
              self._state.box.keywords = keywords = permFlags
                                                    .filter(function(flag) {
                                                      return (flag[0] !== '\\');
                                                    });
              for (var i=0; i<keywords.length; i++)
                permFlags.splice(permFlags.indexOf(keywords[i]), 1);
              self._state.box.permFlags = permFlags.map(function(flag) {
                                            return flag.substr(1);
                                          });
            }
          }
        break;
        case 'NAMESPACE':
          parsers.parseNamespaces(data[2], self.namespaces);
        break;
        case 'SEARCH':
          self._state.requests[0].args.push(data[2] === undefined
                                            || data[2].length === 0
                                            ? [] : data[2].split(' '));
        break;
        case 'LIST':
        case 'XLIST':
          var result;
          if (self.delim === null &&
              (result = /^\(\\No[sS]elect(?:[^)]*)\) (.+?) .*$/.exec(data[2])))
            self.delim = (result[1] === 'NIL'
                          ? false
                          : result[1].substring(1, result[1].length - 1));
          else if (self.delim !== null) {
            if (self._state.requests[0].args.length === 0)
              self._state.requests[0].args.push({});
            result = /^\((.*)\) (.+?) (.+)$/.exec(data[2]);
            var box = {
                  attribs: result[1].split(' ').map(function(attrib) {
                             return attrib.substr(1).toUpperCase();
                           }),
                  delim: (result[2] === 'NIL'
                          ? false
                          : result[2].substring(1, result[2].length-1)),
                  children: null,
                  parent: null
                },
                name = result[3],
                curChildren = self._state.requests[0].args[0];

            if (name[0] === '"' && name[name.length-1] === '"')
              name = name.substring(1, name.length - 1);

            if (box.delim) {
              var path = name.split(box.delim).filter(utils.isNotEmpty),
                  parent = null;
              name = path.pop();
              for (var i=0,len=path.length; i<len; i++) {
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
        default:
          if (/^\d+$/.test(data[1])) {
            var isUnsolicited =
              (self._state.requests[0]
               && self._state.requests[0].command.indexOf('NOOP') > -1
              )
              ||
              (self._state.isIdle && self._state.ext.idle.state === IDLE_READY);
            switch (data[2]) {
              case 'EXISTS':
                // mailbox total message count
                var prev = self._state.box.messages.total,
                    now = parseInt(data[1]);
                self._state.box.messages.total = now;
                if (self._state.status !== STATES.BOXSELECTING && now > prev) {
                  self._state.box.messages.new = now-prev;
                  self.emit('mail', self._state.box.messages.new); // new mail
                }
              break;
              case 'RECENT':
                // messages marked with the \Recent flag (i.e. new messages)
                self._state.box.messages.new = parseInt(data[1]);
              break;
              case 'EXPUNGE':
                // confirms permanent deletion of a single message
                if (self._state.box.messages.total > 0)
                  self._state.box.messages.total--;
                if (isUnsolicited)
                  self.emit('deleted', parseInt(data[1], 10));
              break;
              default:
                // fetches without header or body (part) retrievals
                if (/^FETCH/.test(data[2])) {
                  var msg = new ImapMessage();
                  parsers.parseFetch(data[2].substring(data[2].indexOf("(") + 1,
                                                       data[2].lastIndexOf(")")
                                                      ), /*"",*/ msg);
                  msg.seqno = parseInt(data[1], 10);
                  if (self._state.requests.length &&
                      self._state.requests[0].command.indexOf('FETCH') > -1) {
                    var curReq = self._state.requests[0];
                    curReq._fetcher.emit('message', msg);
                    msg.emit('end');
                  } else if (isUnsolicited)
                    self.emit('msgupdate', msg);
                }
            }
          }
      }
    } else if (data[0][0] === 'A' || data[0] === '+') {
      // Tagged server response or continuation response

      if (data[0] === '+' && self._state.ext.idle.state === IDLE_WAIT) {
        self._state.ext.idle.state = IDLE_READY;
        return process.nextTick(function() { self._send(); });
      }

      var sendBox = false;
      clearTimeout(self._state.tmrKeepalive);

      if (self._state.status === STATES.BOXSELECTING) {
        if (data[1] === 'OK') {
          sendBox = true;
          self._state.status = STATES.BOXSELECTED;
        } else {
          self._state.status = STATES.AUTH;
          self._resetBox();
        }
      }

      if (self._state.requests[0].command.indexOf('RENAME') > -1) {
        self._state.box.name = self._state.box._newName;
        delete self._state.box._newName;
        sendBox = true;
      }

      if (typeof self._state.requests[0].callback === 'function') {
        var err = null;
        var args = self._state.requests[0].args,
            cmd = self._state.requests[0].command;
        if (data[0] === '+') {
          if (cmd.indexOf('APPEND') !== 0) {
            err = new Error('Unexpected continuation');
            err.type = 'continuation';
            err.request = cmd;
          } else
            return self._state.requests[0].callback();
        } else if (data[1] !== 'OK') {
          err = new Error('Error while executing request: ' + data[2]);
          err.type = data[1];
          err.request = cmd;
        } else if (self._state.status === STATES.BOXSELECTED) {
          if (sendBox) // SELECT, EXAMINE, RENAME
            args.unshift(self._state.box);
          // According to RFC 3501, UID commands do not give errors for
          // non-existant user-supplied UIDs, so give the callback empty results
          // if we unexpectedly received no untagged responses.
          else if ((cmd.indexOf('UID FETCH') === 0
                    || cmd.indexOf('UID SEARCH') === 0
                   ) && args.length === 0)
            args.unshift([]);
        }
        args.unshift(err);
        self._state.requests[0].callback.apply({}, args);
      }


      var recentCmd = self._state.requests[0].command;
      self._state.requests.shift();
      if (self._state.requests.length === 0
          && recentCmd !== 'LOGOUT') {
        if (self._state.status === STATES.BOXSELECTED
            && self._serverSupports('IDLE')) {
          // According to RFC 2177, we should re-IDLE at least every 29
          // minutes to avoid disconnection by the server
          self._send('IDLE', undefined, true);
        }
        self._state.tmrKeepalive = setTimeout(function() {
          if (self._state.isIdle) {
            if (self._state.ext.idle.state === IDLE_READY) {
              self._state.ext.idle.timeWaited += self._state.tmoKeepalive;
              if (self._state.ext.idle.timeWaited >= self._state.ext.idle.MAX_WAIT)
                self._send('IDLE', undefined, true); // restart IDLE
            } else if (!self._serverSupports('IDLE'))
              self._noop();
          }
        }, self._state.tmoKeepalive);
      } else
        process.nextTick(function() { self._send(); });

      self._state.isIdle = true;
    } else if (data[0] === 'IDLE') {
      if (self._state.requests.length)
        process.nextTick(function() { self._send(); });
      self._state.isIdle = false;
      self._state.ext.idle.state = IDLE_NONE;
      self._state.ext.idle.timeWaited = 0;
    } else {
      // unknown response
    }
  });

  this._state.conn.connect(this._options.port, this._options.host);
  this._state.tmrConn = setTimeout(this._fnTmrConn.bind(this, loginCb),
                                   this._options.connTimeout);
};

ImapConnection.prototype.isAuthenticated = function() {
  return this._state.status >= STATES.AUTH;
};

ImapConnection.prototype.logout = function(cb) {
  if (this._state.status >= STATES.NOAUTH)
    this._send('LOGOUT', cb);
  else
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
  this._state.status = STATES.BOXSELECTING;
  this._state.box.name = name;

  this._send((readOnly ? 'EXAMINE' : 'SELECT') + ' "' + utils.escape(name)
             + '"', cb);
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
  var self = this;
  if (this._state.status === STATES.BOXSELECTED
      && this._state.box.name === boxName)
    throw new Error('Not allowed to call status on the currently selected mailbox');

  var cmd = 'STATUS "';
  cmd += utils.escape(boxName);
  cmd += '" (MESSAGES RECENT UIDVALIDITY)';

  this._send(cmd, cb);
};

ImapConnection.prototype.removeDeleted = function(cb) {
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  cb = arguments[arguments.length - 1];

  this._send('EXPUNGE', cb);
};

ImapConnection.prototype.getBoxes = function(namespace, cb) {
  cb = arguments[arguments.length - 1];
  if (arguments.length !== 2)
    namespace = '';
  this._send((!this._serverSupports('XLIST') ? 'LIST' : 'XLIST')
             + ' "' + utils.escape(namespace) + '" "*"', cb);
};

ImapConnection.prototype.addBox = function(name, cb) {
  cb = arguments[arguments.length - 1];
  if (typeof name !== 'string' || name.length === 0)
    throw new Error('Mailbox name must be a string describing the full path'
                    + ' of a new mailbox to be created');
  this._send('CREATE "' + utils.escape(name) + '"', cb);
};

ImapConnection.prototype.delBox = function(name, cb) {
  cb = arguments[arguments.length - 1];
  if (typeof name !== 'string' || name.length === 0)
    throw new Error('Mailbox name must be a string describing the full path'
                    + ' of an existing mailbox to be deleted');
  this._send('DELETE "' + utils.escape(name) + '"', cb);
};

ImapConnection.prototype.renameBox = function(oldname, newname, cb) {
  cb = arguments[arguments.length - 1];
  if (typeof oldname !== 'string' || oldname.length === 0)
    throw new Error('Old mailbox name must be a string describing the full path'
                    + ' of an existing mailbox to be renamed');
  else if (typeof newname !== 'string' || newname.length === 0)
    throw new Error('New mailbox name must be a string describing the full path'
                    + ' of a new mailbox to be renamed to');
  if (this._state.status === STATES.BOXSELECTED
      && oldname === this._state.box.name && oldname !== 'INBOX')
    this._state.box._newName = oldname;

  this._send('RENAME "' + utils.escape(oldname) + '" "' + utils.escape(newname)
             + '"', cb);
};

ImapConnection.prototype.append = function(data, options, cb) {
  if (typeof options === 'function') {
    cb = options;
    options = {};
  }
  options = options || {};
  if (!('mailbox' in options)) {
    if (this._state.status !== STATES.BOXSELECTED)
      throw new Error('No mailbox specified or currently selected');
    else
      options.mailbox = this._state.box.name
  }
  cmd = 'APPEND "' + utils.escape(options.mailbox) + '"';
  if ('flags' in options) {
    if (!Array.isArray(options.flags))
      options.flags = Array(options.flags);
    cmd += " (\\" + options.flags.join(' \\') + ")";
  }
  if ('date' in options) {
    if (!(options.date instanceof Date))
      throw new Error('Expected null or Date object for date');
    cmd += ' "' + options.date.getDate() + '-'
           + utils.MONTHS[options.date.getMonth()]
           + '-' + options.date.getFullYear();
    cmd += ' ' + ('0' + options.date.getHours()).slice(-2) + ':'
           + ('0' + options.date.getMinutes()).slice(-2) + ':'
           + ('0' + options.date.getSeconds()).slice(-2);
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
    self._state.conn.cleartext.write(data);
    self._state.conn.cleartext.write(CRLF);
    self.debug&&self.debug('\nCLIENT: ' + util.inspect(data.toString()) + '\n');
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

ImapConnection.prototype.fetch = function(uids, options) {
  return this._fetch('UID ', uids, options);
};

ImapConnection.prototype._fetch = function(which, uids, options) {
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');

  if (uids === undefined || uids === null
      || (Array.isArray(uids) && uids.length === 0))
    throw new Error('Nothing to fetch');

  if (!Array.isArray(uids))
    uids = [uids];
  utils.validateUIDList(uids);

  var opts = {
    markSeen: false,
    request: {
      struct: true,
      headers: true,
      body: false
    }
  }, toFetch, bodyRange, extensions, useParser, self = this;

  if (typeof options !== 'object')
    options = {};
  utils.extend(true, opts, options);

  if (!Array.isArray(opts.request.headers)) {
    if (Array.isArray(opts.request.body)) {
      var rangeInfo;
      if (opts.request.body.length !== 2)
        throw new Error("Expected Array of length 2 for body byte range");
      else if (typeof opts.request.body[1] !== 'string'
               || !(rangeInfo = /^([\d]+)\-([\d]+)$/.exec(opts.request.body[1]))
               || parseInt(rangeInfo[1]) >= parseInt(rangeInfo[2]))
        throw new Error("Invalid body byte range format");
      bodyRange = '<' + parseInt(rangeInfo[1]) + '.' + parseInt(rangeInfo[2])
                  + '>';
      opts.request.body = opts.request.body[0];
    }
    if (opts.request.headers === true && opts.request.body === true) {
      // fetches the whole entire message (including the headers)
      toFetch = '';
      useParser = true;
    } else if (opts.request.headers === true) {
      // fetches headers only
      toFetch = 'HEADER';
      useParser = true;
    } else if (opts.request.body === true) {
      // fetches the whole entire message text (minus the headers), including
      // all message parts
      toFetch = 'TEXT';
    } else if (typeof opts.request.body === 'string') {
      if (opts.request.body.toUpperCase() === 'FULL') {
        // fetches the whole entire message (including the headers)
        // NOTE: does NOT parse the headers!
        toFetch = '';
      } else if (/^([\d]+[\.]{0,1})*[\d]+$/.test(opts.request.body)) {
        // specific message part identifier, e.g. '1', '2', '1.1', '1.2', etc
        toFetch = opts.request.body;
      } else
        throw new Error("Invalid body partID format");
    }
  } else {
    // fetch specific headers only
    toFetch = 'HEADER.FIELDS (' + opts.request.headers.join(' ').toUpperCase()
              + ')';
    useParser = true;
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
  cmd += (opts.request.struct ? ' BODYSTRUCTURE' : '');
  if (toFetch !== undefined) {
    cmd += ' BODY';
    if (!opts.markSeen)
      cmd += '.PEEK';
    cmd += '[';
    cmd += toFetch;
    cmd += ']';
    if (bodyRange)
      cmd += bodyRange;
  }
  cmd += ')';

  this._send(cmd, function(e) {
    var fetcher = self._state.requests[0]._fetcher;
    if (e && fetcher)
      fetcher.emit('error', e);
    else if (e && !fetcher)
      self.emit('error', e);
    else if (fetcher)
      fetcher.emit('end');
  });
  var imapFetcher = new ImapFetch(),
      req = this._state.requests[this._state.requests.length - 1];
  req._fetcher = imapFetcher;
  req._useParser = useParser;
  return imapFetcher;
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
  if (!this._state.box._newKeywords)
    throw new Error('This mailbox does not allow new keywords to be added');
  this._store(which, uids, flags, true, cb);
};

ImapConnection.prototype.delKeywords = function(uids, flags, cb) {
  this._store('UID ', uids, flags, false, cb);
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

  this._send(which + 'COPY ' + uids.join(',') + ' "' + utils.escape(boxTo)
             + '"', cb);
};

ImapConnection.prototype.move = function(uids, boxTo, cb) {
  return this._move('UID ', uids, boxTo, cb);
};

ImapConnection.prototype._move = function(which, uids, boxTo, cb) {
  var self = this;
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  if (self._state.box.permFlags.indexOf('Deleted') === -1) {
    throw new Error('Cannot move message: '
                    + 'server does not allow deletion of messages');
  } else {
    self._copy(which, uids, boxTo, function(err, reentryCount, deletedUIDs,
                                             counter) {
      if (err) {
        cb(err);
        return;
      }

      var fnMe = arguments.callee;
      counter = counter || 0;
      // Make sure we don't expunge any messages marked as Deleted except the
      // one we are moving
      if (reentryCount === undefined) {
        self.search(['DELETED'], function(e, result) {
          fnMe.call(this, e, 1, result);
        });
      } else if (reentryCount === 1) {
        if (counter < deletedUIDs.length) {
          self.delFlags(deletedUIDs[counter], 'Deleted', function(e) {
            process.nextTick(function() {
              fnMe.call(this, e, reentryCount, deletedUIDs, counter + 1);
            });
          });
        } else
          fnMe.call(this, err, reentryCount + 1, deletedUIDs);
      } else if (reentryCount === 2) {
        self.addFlags(uids, 'Deleted', function(e) {
          fnMe.call(this, e, reentryCount + 1, deletedUIDs);
        });
      } else if (reentryCount === 3) {
        self.removeDeleted(function(e) {
          fnMe.call(this, e, reentryCount + 1, deletedUIDs);
        });
      } else if (reentryCount === 4) {
        if (counter < deletedUIDs.length) {
          self.addFlags(deletedUIDs[counter], 'Deleted', function(e) {
            process.nextTick(function() {
              fnMe.call(this, e, reentryCount, deletedUIDs, counter + 1);
            });
          });
        } else
          cb();
      }
    });
  }
};

/* Namespace for seqno-based commands */
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
    fetch: function(seqnos, options) {
      return self._fetch('', seqnos, options);
    },
    search: function(options, cb) {
      self._search('', options, cb);
    }
  };
});


/****** Private Functions ******/

ImapConnection.prototype._fnTmrConn = function(loginCb) {
  loginCb(new Error('Connection timed out'));
  this._state.conn.destroy();
};

ImapConnection.prototype._serverSupports = function(capability) {
  return (this.capabilities.indexOf(capability) > -1);
};

ImapConnection.prototype._store = function(which, uids, flags, isAdding, cb) {
  var isKeywords = (arguments.callee.caller === this.addKeywords
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
      if (this._state.box.permFlags.indexOf(flags[i]) === -1
          || flags[i] === '\\*' || flags[i] === '*')
        throw new Error('The flag "' + flags[i]
                        + '" is not allowed by the server for this mailbox');
    } else {
      // keyword contains any char except control characters (%x00-1F and %x7F)
      // and: '(', ')', '{', ' ', '%', '*', '\', '"', ']'
      if (/[\(\)\{\\\"\]\%\*\x00-\x20\x7F]/.test(flags[i])) {
        throw new Error('The keyword "' + flags[i]
                        + '" contains invalid characters');
      }
    }
  }
  if (!isKeywords)
    flags = flags.map(function(flag) {return '\\' + flag;})
  flags = flags.join(' ');
  cb = arguments[arguments.length-1];

  this._send(which + 'STORE ' + uids.join(',') + ' ' + (isAdding ? '+' : '-')
             + 'FLAGS.SILENT (' + flags + ')', cb);
};

ImapConnection.prototype._login = function(cb) {
  var self = this,
      fnReturn = function(err) {
        if (!err) {
          self._state.status = STATES.AUTH;
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

    if (this._serverSupports('AUTH=XOAUTH') && 'xoauth' in this._options) {
      this._send('AUTHENTICATE XOAUTH ' + utils.escape(this._options.xoauth),
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
  this._state.numCapRecvs = 0;
  this._state.requests = [];
  this._state.isIdle = true;
  this._state.isReady = false;
  this._state.ext.idle.state = IDLE_NONE;
  this._state.ext.idle.timeWaited = 0;

  this.namespaces = { personal: [], other: [], shared: [] };
  this.delim = null;
  this.capabilities = [];
  this._resetBox();
};

ImapConnection.prototype._resetBox = function() {
  this._state.box._uidnext = 0;
  this._state.box._flags = [];
  this._state.box._newKeywords = false;
  this._state.box.validity = 0;
  this._state.box.permFlags = [];
  this._state.box.keywords = [];
  this._state.box.name = null;
  this._state.box.messages.total = 0;
  this._state.box.messages.new = 0;
};

ImapConnection.prototype._noop = function() {
  if (this._state.status >= STATES.AUTH)
    this._send('NOOP');
};

ImapConnection.prototype._send = function(cmdstr, cb, bypass) {
  if (cmdstr !== undefined && !bypass)
    this._state.requests.push({ command: cmdstr, callback: cb, args: [] });
  if (this._state.ext.idle.state === IDLE_WAIT)
    return;
  if ((cmdstr === undefined && this._state.requests.length) ||
      this._state.requests.length === 1 || bypass) {
    var prefix = '', cmd = (bypass ? cmdstr : this._state.requests[0].command);
    clearTimeout(this._state.tmrKeepalive);
    if (this._state.ext.idle.state === IDLE_READY && cmd !== 'DONE')
      return this._send('DONE', undefined, true);
    else if (cmd === 'IDLE') {
       // we use a different prefix to differentiate and disregard the tagged
       // response the server will send us when we issue DONE
      prefix = 'IDLE ';
      this._state.ext.idle.state = IDLE_WAIT;
    }
    if (cmd !== 'IDLE' && cmd !== 'DONE')
      prefix = 'A' + ++this._state.curId + ' ';
    this._state.conn.cleartext.write(prefix);
    this._state.conn.cleartext.write(cmd);
    this._state.conn.cleartext.write(CRLF);
    this.debug&&this.debug('\nCLIENT: ' + prefix + cmd + '\n');
  }
};

function ImapMessage() {}
util.inherits(ImapMessage, EventEmitter);

function ImapFetch() {}
util.inherits(ImapFetch, EventEmitter);
