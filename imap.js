var sys = require('sys'), net = require('net'), EventEmitter = require('events').EventEmitter;
var empty = function() {}, CRLF = "\r\n", debug=empty/*sys.debug*/, STATES = { NOCONNECT: 0, NOAUTH: 1, AUTH: 2, BOXSELECTING: 3, BOXSELECTED: 4 };

function ImapConnection (options) {
  this._options = {
    username: '',
    password: '',
    host: 'localhost',
    port: 143,
    secure: false
  };
  this._state = {
    status: STATES.NOCONNECT,
    conn: null,
    curId: 0,
    requests: [],
    numCapRecvs: 0,
    isReady: false,
    isIdle: true,
    delim: '/',
    tmrKeepalive: null,
    tmoKeepalive: 10000,
    curData: '',
    fetchData: { flags: [], date: null, headers: null, body: null, structure: null, _total: 0 },
    box: { _uidnext: 0, _uidvalidity: 0, _flags: [], permFlags: [], name: null, messages: { total: 0, new: 0 }}
  };
  this._capabilities = [];

  this._options = extend(true, this._options, options);
};
sys.inherits(ImapConnection, EventEmitter);
exports.ImapConnection = ImapConnection;

ImapConnection.prototype.connect = function(loginCb) {
  var self = this;
  var fnInit = function() {
    // First get pre-auth capabilities, including server-supported auth mechanisms
    self._send('CAPABILITY', function() {
      // Next attempt to login
      self._login(function(err) {
        if (err) {
          loginCb(err);
          return;
        }
        // Lastly, get the mailbox hierarchy delimiter/separator used by the server
        self._send('LIST "" ""', loginCb);
      });
    });
  };
  this._reset();

  this._state.conn = net.createConnection(this._options.port, this._options.host);
  if (this._options.secure) {
    this._state.conn.setSecure();
    this._state.conn.on('secure', function() {
      debug('Secure connection made.');
    });
  }
  this._state.conn.setKeepAlive(true);
  this._state.conn.setEncoding('utf8');

  this._state.conn.on('connect', function() {
    debug('Connected to host.');
    self._state.conn.write('');
    self._state.status = STATES.NOAUTH;
  });
  this._state.conn.on('ready', function() {
    fnInit();
  });
  this._state.conn.on('data', function(data) {
    var literalData = '';
    debug('RECEIVED: ' + data);

    if (data.indexOf(CRLF) === -1) {
      if (self._state.curData)
        self._state.curData += data;
      else
        self._state.curData = data;
      return;
    }
    if (self._state.curData)
      data = self._state.curData + data;
    self._state.curData = undefined;

    // Don't mess with incoming data if it's part of a literal
    if (/\{(\d+)\}$/.test(data.substr(0, data.indexOf(CRLF)))) {
      var result = /\{(\d+)\}$/.exec(data.substr(0, data.indexOf(CRLF))),
          total = parseInt(result[1]);
      self._state.fetchData._total = total;
    }
    if (self._state.fetchData._total > 0) {
      if (data.length - (data.indexOf(CRLF)+2) <= self._state.fetchData._total) {
        self._state.curData = data;
        return;
      }
      literalData = data.substr(data.indexOf(CRLF)+2, total);
      data = data.substr(0, data.indexOf(CRLF)) + data.substr(data.indexOf(CRLF) + 3 + total);
      self._state.fetchData._total = 0;
    }

    data = data.split(CRLF).filter(isNotEmpty);

    // Defer any extra server responses found in the incoming data
    if (data.length > 1) {
      data.slice(1).forEach(function(line) {
        process.nextTick(function() { self._state.conn.emit('data', line + CRLF); });
      });
    }
    data = data[0];
    data = data.explode(' ', 3);

    if (data[0] === '+') { // Continuation
      // Should never happen ....
    } else if (data[0] === '*') { // Untagged server response
      if (self._state.status === STATES.NOAUTH) {
        if (data[1] === 'PREAUTH') { // no need to login, the server pre-authenticated us
          self._state.status = STATES.AUTH;
          if (self._state.numCapRecvs === 0)
            self._state.numCapRecvs = 1;
        } else if (data[1] === 'NO' || data[1] === 'BAD' || data[1] === 'BYE') {
          self._state.conn.end();
          return;
        }
        if (!self._state.isReady) {
          self._state.isReady = true;
          self._state.conn.emit('ready');
        }
        // Restrict the type of server responses when unauthenticated
        if (data[1] !== 'CAPABILITY' || data[1] !== 'ALERT')
          return;
      }
      switch (data[1]) {
        case 'CAPABILITY':
          if (self._state.numCapRecvs < 2)
            self._state.numCapRecvs++;
          self._capabilities = data[2].split(' ').map(up);
        break;
        case 'FLAGS':
          if (self._state.status === STATES.BOXSELECTING)
            self._state.box._flags = data[2].substr(1, data[2].length-2).split(' ');
        case 'OK':
          if ((result = /^\[ALERT\] (.*)$/i.exec(data[2])) !== null)
            self.emit('alert', result[1]);
          else if (self._state.status === STATES.BOXSELECTING) {
            var result;
            if ((result = /^\[UIDVALIDITY (\d+)\]$/i.exec(data[2])) !== null)
              self._state.box._uidvalidity = result[1];
            else if ((result = /^\[UIDNEXT (\d+)\]$/i.exec(data[2])) !== null)
              self._state.box._uidnext = result[1];
            else if ((result = /^\[PERMANENTFLAGS \((.*)\)\]$/i.exec(data[2])) !== null)
              self._state.box.permFlags = result[1].split(' ');
          }
        break;
        case 'SEARCH':
          self._state.box._lastSearch = data[2].split(' ');
        break;
        case 'LIST':
          var result;
          if ((result = /^\(\\Noselect\) "(.+)" ""$/.exec(data[2])) !== null)
            self._state.delim = result[1];
        break;
        default:
          if (/^\d+$/.test(data[1])) {
            switch (data[2]) {
              case 'EXISTS': // mailbox total message count
                self._state.box.messages.total = parseInt(data[1]);
              break;
              case 'RECENT': // messages marked with the \Recent flag (i.e. new messages)
                self._state.box.messages.new = parseInt(data[1]);
                if (self._state.status !== STATES.BOXSELECTING)
                  self.emit('mail', self._state.box.messages.new); // new mail notification
              break;
              case 'EXPUNGE': // confirms permanent deletion of a single message
                if (self._state.box.messages.total > 0)
                  self._state.box.messages.total--;
              break;
              default:
                // Check for FETCH result
                if (/^FETCH /i.test(data[2])) {
                  var regex = "\\(UID ([\\d]+) INTERNALDATE \"(.*?)\" FLAGS \\((.*?)\\)", result;
                  if ((result = new RegExp(regex + " BODYSTRUCTURE \\((.*\\))(?=\\)|[\\s])").exec(data[2])))
                    self._state.fetchData.structure = parseBodyStructure(result[4]);
                  result = new RegExp(regex).exec(data[2]);
                  self._state.fetchData.date = result[2];
                  self._state.fetchData.flags = result[3].split(' ').filter(isNotEmpty);
                  if (literalData.length > 0) {
                    result = /BODY\[(.*)\](?:\<[\d]+\>)? \{[\d]+\}$/.exec(data[2]);
                    if (result[1].indexOf('HEADER') === 0) { // either full or selective headers
                      var headers = literalData.split(/\r\n(?=[\w])/), header;
                      self._state.fetchData.headers = {};
                      for (var i=0,len=headers.length; i<len; i++) {
                        header = headers[i].substr(0, headers[i].indexOf(': ')).toLowerCase();
                        if (!self._state.fetchData.headers[header])
                          self._state.fetchData.headers[header] = [];
                        self._state.fetchData.headers[header].push(headers[i].substr(headers[i].indexOf(': ')+2).replace(/\r\n/g, '').trim());
                      }
                    } else // full message or part body
                      self._state.fetchData.body = literalData;
                  }
                }
              break;
            }
          }
      }
    } else if (data[0].indexOf('A') === 0) { // Tagged server response
      //var id = data[0].substr(1);
      clearTimeout(self._state.tmrKeepalive);
      self._state.tmrKeepalive = setTimeout(self._idleCheck.bind(self), self._state.tmoKeepalive);

      if (self._state.status === STATES.BOXSELECTING) {
        if (data[1] === 'OK')
          self._state.status = STATES.BOXSELECTED;
        else {
          self._state.status = STATES.AUTH;
          self._resetBox();
        }
      }

      if (typeof self._state.requests[0].callback === 'function') {
        var err = null;
        if (data[1] !== 'OK') {
          err = new Error('Error while executing request: ' + data[2]);
          err.type = data[1];
          err.request = self._state.requests[0].command;
          self._state.requests[0].callback(err);
        } else if (self._state.status === STATES.BOXSELECTED) {
          if (data[2].indexOf('SEARCH') === 0) {
            var result = self._state.box._lastSearch;
            self._state.box._lastSearch = null;
            self._state.requests[0].callback(err, self._state.box, result);
          } else if (self._state.requests[0].command.indexOf('UID FETCH') === 0)
            self._state.requests[0].callback(err, self._state.box, self._state.fetchData);
          else
            self._state.requests[0].callback(err, self._state.box);
        } else
          self._state.requests[0].callback(err);
      }

      self._state.requests.shift();
      process.nextTick(function() { self._send(); });
      self._state.isIdle = true;
      self._resetFetch();
    } else {
      // unknown response
    }
  });
  this._state.conn.on('error', function(err) {
    debug('Encountered error: ' + err);
  });
  this._state.conn.on('end', function() {
    self._reset();
    debug('FIN packet received. Disconnecting...');
    self.emit('end');
  });
  this._state.conn.on('error', function(err) {
    self.emit('error', err);
    debug('Error occurred: ' + err);
  });
  this._state.conn.on('close', function(had_error) {
    self._reset();
    debug('Connection forcefully closed.');
    self.emit('close', had_error);
  });
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
  else if (typeof name !== 'string')
    name = 'INBOX';
  if (this._state.status === STATES.BOXSELECTED)
    this._resetBox();
  if (typeof readOnly !== 'boolean')
    readOnly = false;
  cb = arguments[arguments.length-1];
  this._state.status = STATES.BOXSELECTING;
  this._state.box.name = name;

  this._send((readOnly ? 'EXAMINE' : 'SELECT') + ' "' + escape(name) + '"', cb);
};

ImapConnection.prototype.closeBox = function(cb) { // also deletes any messages in this box marked with \Deleted
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

ImapConnection.prototype.search = function(options, cb) {
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  if (!Array.isArray(options))
    throw new Error('Expected array for search options');
  var searchargs = '', months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (var i=0,len=options.length; i<len; i++) {
    var criteria = options[i], args = null, modifier = ' ';
    if (typeof criteria === 'string')
      criteria = criteria.toUpperCase();
    else if (Array.isArray(criteria)) {
      if (criteria.length > 1)
        args = criteria.slice(1);
      if (criteria.length > 0)
        criteria = criteria[0].toUpperCase();
    } else
      throw new Error('Unexpected search option data type. Expected string, number, or array. Got: ' + typeof criteria);
    if (criteria[0] === '!') {
      modifier += 'NOT ';
      criteria = criteria.substr(1);
    }
    switch(criteria) {
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
          throw new Error('Incorrect number of arguments for search option: ' + criteria);
        searchargs += modifier + criteria + ' "' + escape(''+args[0]) + '"';
      break;
      case 'BEFORE':
      case 'ON':
      case 'SENTBEFORE':
      case 'SENTON':
      case 'SENTSINCE':
      case 'SINCE':
        if (!args || args.length !== 1)
          throw new Error('Incorrect number of arguments for search option: ' + criteria);
        else if (!(args[0] instanceof Date)) {
          if ((args[0] = new Date(args[0])).toString() === 'Invalid Date')
            throw new Error('Search option argument must be a Date object or a parseable date');
        }
        searchargs += modifier + criteria + ' ' + args[0].getDate() + '-' + months[args[0].getMonth()] + '-' + args[0].getFullYear();
      break;
      /*case 'KEYWORD':
      case 'UNKEYWORD':
        if (!args || args.length !== 1)
          throw new Error('Incorrect number of arguments for search option: ' + criteria);
        searchargs += modifier + criteria + ' ' + args[0];
      break;*/
      case 'LARGER':
      case 'SMALLER':
        if (!args || args.length !== 1)
          throw new Error('Incorrect number of arguments for search option: ' + criteria);
        var num = parseInt(args[0]);
        if (isNaN(num))
          throw new Error('Search option argument must be a number');
        searchargs += modifier + criteria + ' ' + args[0];
      break;
      case 'HEADER':
        if (!args || args.length !== 2)
          throw new Error('Incorrect number of arguments for search option: ' + criteria);
        searchargs += modifier + criteria + ' "' + escape(''+args[0]) + '" "' + escape(''+args[1]) + '"';
      break;
      default:
        throw new Error('Unexpected search option: ' + criteria);
    }
  }
  this._send('UID SEARCH' + searchargs, cb);
};

ImapConnection.prototype.fetch = function(uid, options, cb) {
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  if (arguments.length < 1)
    throw new Error('The message ID must be specified');
  if (isNaN(parseInt(''+uid)))
    throw new Error('Message ID must be a number');
  var defaults = {
    markSeen: false,
    request: {
      struct: true,
      headers: true, // \_______ at most one of these can be used for any given fetch request
      body: false   //  /
    }
  }, toFetch, bodyRange = '';
  cb = arguments[arguments.length-1];
  if (typeof options !== 'object')
    options = {};
  options = extend(true, defaults, options);

  if (!Array.isArray(options.request.headers)) {
    if (Array.isArray(options.request.body)) {
      var rangeInfo;
      if (options.request.body.length !== 2)
        throw new Error("Expected Array of length 2 for body property for byte range");
      else if (typeof options.request.body[1] !== 'string'
               || !(rangeInfo = /^([\d]+)\-([\d]+)$/.exec(options.request.body[1]))
               || parseInt(rangeInfo[1]) >= parseInt(rangeInfo[2]))
        throw new Error("Invalid body byte range format");
      bodyRange = '<' + parseInt(rangeInfo[1]) + '.' + parseInt(rangeInfo[2]) + '>';
      options.request.body = options.request.body[0];
    }
    if (typeof options.request.headers === 'boolean' && options.request.headers === true)
      toFetch = 'HEADER'; // fetches headers only
    else if (typeof options.request.body === 'boolean' && options.request.body === true)
      toFetch = 'TEXT'; // fetches the whole entire message text (minus the headers), including all message parts
    else if (typeof options.request.body === 'string') {
      if (!/^([\d]+[\.]{0,1})*[\d]+$/.test(options.request.body))
        throw new Error("Invalid body partID format");
      toFetch = options.request.body; // specific message part identifier, e.g. '1', '2', '1.1', '1.2', etc
    }
  } else
    toFetch = 'HEADER.FIELDS (' + options.request.headers.join(' ').toUpperCase() + ')'; // fetch specific headers only

  this._resetFetch();
  this._send('UID FETCH ' + uid + ' (FLAGS INTERNALDATE'
            + (options.request.struct ? ' BODYSTRUCTURE' : '')
            + (toFetch ? ' BODY' + (!options.markSeen ? '.PEEK' : '') + '[' + toFetch + ']' + bodyRange : '') + ')', cb);
};

ImapConnection.prototype.removeDeleted = function(cb) {
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  cb = arguments[arguments.length-1];

  this._send('EXPUNGE', cb);
};

ImapConnection.prototype.addFlags = function(uid, flags, cb) {
  try {
    this._storeFlag(uid, flags, true, cb);
  } catch (err) {
    throw err;
  }
};

ImapConnection.prototype.delFlags = function(uid, flags, cb) {
  try {
    this._storeFlag(uid, flags, false, cb);
  } catch (err) {
    throw err;
  }  
};

/****** Private Functions ******/

ImapConnection.prototype._storeFlag = function(uid, flags, isAdding, cb) {
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  if (typeof uid === 'undefined')
    throw new Error('The message ID must be specified');
  if (isNaN(parseInt(''+uid)))
    throw new Error('Message ID must be a number');
  if ((!Array.isArray(flags) && typeof flags !== 'string') || (Array.isArray(flags) && flags.length === 0))
    throw new Error('Flags argument must be a string or a non-empty Array');
  if (!Array.isArray(flags))
    flags = [flags];
  for (var i=0; i<flags.length; i++) {
    if (this._state.box.permFlags.indexOf(flags[i]) === -1 || flags[i] === '\*')
      throw new Error('The flag "' + flags[i] + '" is not allowed by the server for this mailbox');
  }
  cb = arguments[arguments.length-1];

  this._send('UID STORE ' + uid + ' ' + (isAdding ? '+' : '-') + 'FLAGS.SILENT (' + flags.join(' ') + ')', cb);
};

ImapConnection.prototype._login = function(cb) {
  var self = this,
      fnReturn = function(err) {
        if (!err) {
          self._state.status = STATES.AUTH;
          if (self._state.numCapRecvs !== 2) {
            self._send('CAPABILITY', cb); // fetch post-auth server capabilities if they were not automatically provided after login
            return;
          }
        }
        cb(err);
      };
  if (this._state.status === STATES.NOAUTH) {
    if (typeof this._capabilities.LOGINDISABLED !== 'undefined') {
      cb(new Error('Logging in is disabled on this server'));
      return;
    }
    //if (typeof this._capabilities['AUTH=PLAIN'] !== 'undefined') {
      this._send('LOGIN "' + escape(this._options.username) + '" "' + escape(this._options.password) + '"', fnReturn);
    /*} else {
      cb(new Error('Unsupported authentication mechanism(s) detected. Unable to login.'));
      return;
    }*/
  }
};
ImapConnection.prototype._reset = function() {
  clearTimeout(this._state.tmrKeepalive);
  this._state.status = STATES.NOCONNECT;
  this._state.numCapRecvs = 0;
  this._state.requests = [];
  this._capabilities = [];
  this._state.isIdle = true;
  this._state.isReady = false;
  this._state.delim = '/';
  this._resetBox();
  this._resetFetch();
};
ImapConnection.prototype._resetBox = function() {
  this._state.box._uidnext = 0;
  this._state.box._uidvalidity = 0;
  this._state.box._flags = [];
  this._state.box._lastSearch = null;
  this._state.box.permFlags = [];
  this._state.box.name = null;
  this._state.box.messages.total = 0;
  this._state.box.messages.new = 0;
};
ImapConnection.prototype._resetFetch = function() {
  this._state.fetchData.flags = [];
  this._state.fetchData.date = null;
  this._state.fetchData.headers = null;
  this._state.fetchData.body = null;
  this._state.fetchData.structure = null;
  this._state.fetchData._total = 0;
};
ImapConnection.prototype._idleCheck = function() {
  if (this._state.isIdle)
    this._noop();
};
ImapConnection.prototype._noop = function() {
  if (this._state.status >= STATES.AUTH)
    this._send('NOOP', undefined, true);
};
ImapConnection.prototype._send = function(cmdstr, cb, bypass) {
  if (arguments.length > 0 && !bypass)
    this._state.requests.push({ command: cmdstr, callback: cb });
  if ((arguments.length === 0 && this._state.requests.length > 0) || this._state.requests.length === 1 || bypass) {
    clearTimeout(this._state.tmrKeepalive);
    this._state.isIdle = false;
    var cmd = (bypass ? cmdstr : this._state.requests[0].command);
    this._state.conn.write('A' + ++this._state.curId + ' ' + cmd + CRLF);
    debug('SENT: A' + this._state.curId + ' ' + cmd);
  }
};

/****** Utility Functions ******/

function parseBodyStructure(str, prefix, partID) {
  var retVal = [];
  prefix = (prefix !== undefined ? prefix : '');
  partID = (partID !== undefined ? partID : 1);
  if (str[0] === '(') { // multipart
    var extensionData = {
      type: null, // required
      params: null, disposition: null, language: null, location: null // optional and may be omitted completely
    };
    // Recursively parse each part
    while (str[0] === '(') {
      var inQuote = false,
          countParen = 0,
          lastIndex = -1;
      for (var i=1,len=str.length; i<len; i++) {
        if (str[i-1] !== "\\" && str[i] === "\"")
          inQuote = !inQuote;
        else if (!inQuote) {
          if (str[i] === '(')
            countParen++;
          else if (str[i] === ')') {
            if (countParen === 0) {
              lastIndex = i;
              break;
            } else
              countParen--;
          }
        }
      }
      retVal.push(parseBodyStructure(str.substr(1, lastIndex-1), prefix + (prefix !== '' ? '.' : '') + (partID++).toString(), 1));
      str = str.substr(lastIndex+1).trim();
    }

    // multipart type
    lastIndex = getLastIdxQuoted(str);
    extensionData.type = str.substring(1, lastIndex).toLowerCase();
    str = str.substr(lastIndex+1).trim();

    // [parameters]
    if (str.length > 0) {
      if (str[0] === '(') {
        var isKey = true, key;
        str = str.substr(1);
        extensionData.params = {};
        while (str[0] !== ')') {
          lastIndex = getLastIdxQuoted(str);
          if (isKey)
            key = str.substring(1, lastIndex).toLowerCase();
          else
            extensionData.params[key] = str.substring(1, lastIndex);
          str = str.substr(lastIndex+1).trim();
          isKey = !isKey;
        }
        str = str.substr(1).trim();
      } else
        str = str.substr(4);

      // [disposition]
      if (str.length > 0) {
        if (str.substr(0, 3) !== 'NIL') {
          extensionData.disposition = { type: null, params: null };
          str = str.substr(1);
          lastIndex = getLastIdxQuoted(str);
          extensionData.disposition.type = str.substring(1, lastIndex).toLowerCase();
          str = str.substr(lastIndex+1).trim();
          if (str[0] === '(') {
            var isKey = true, key;
            str = str.substr(1);
            extensionData.disposition.params = {};
            while (str[0] !== ')') {
              lastIndex = getLastIdxQuoted(str);
              if (isKey)
                key = str.substring(1, lastIndex).toLowerCase();
              else
                extensionData.disposition.params[key] = str.substring(1, lastIndex);
              str = str.substr(lastIndex+1).trim();
              isKey = !isKey;
            }
            str = str.substr(2).trim();
          } else
            str = str.substr(4).trim();
        } else
          str = str.substr(4);

        // [language]
        if (str.length > 0) {
          if (str.substr(0, 3) !== 'NIL') {
            lastIndex = getLastIdxQuoted(str);
            extensionData.language = str.substring(1, lastIndex);
            str = str.substr(lastIndex+1).trim();
          } else
            str = str.substr(4);

          // [location]
          if (str.length > 0) {
            if (str.substr(0, 3) !== 'NIL') {
              lastIndex = getLastIdxQuoted(str);
              extensionData.location = str.substring(1, lastIndex);
              str = str.substr(lastIndex+1).trim();
            } else
              str = str.substr(4);
          }
        }
      }
    }

    retVal.unshift(extensionData);
  } else { // single part
    var part = {
          partID: (prefix !== '' ? prefix : '1'), // the path identifier for this part, useful for fetching specific parts of a message
          type: { name: null, params: null }, // content type and parameters (NIL or otherwise)
          id: null, description: null, encoding: null, size: null, lines: null, // required -- NIL or otherwise
          md5: null, disposition: null, language: null, location: null // optional extension data that may be omitted entirely
        },
        lastIndex = getLastIdxQuoted(str),
        contentTypeMain = str.substring(1, lastIndex),
        contentTypeSub;
    str = str.substr(lastIndex+1).trim();
    lastIndex = getLastIdxQuoted(str);
    contentTypeSub = str.substring(1, lastIndex);
    str = str.substr(lastIndex+1).trim();

    // content type
    part.type.name = contentTypeMain.toLowerCase() + '/' + contentTypeSub.toLowerCase();

    // content type parameters
    if (str[0] === '(') {
      var isKey = true, key;
      str = str.substr(1);
      part.type.params = {};
      while (str[0] !== ')') {
        lastIndex = getLastIdxQuoted(str);
        if (isKey)
          key = str.substring(1, lastIndex).toLowerCase();
        else
          part.type.params[key] = str.substring(1, lastIndex);
        str = str.substr(lastIndex+1).trim();
        isKey = !isKey;
      }
      str = str.substr(2);
    } else
      str = str.substr(4);

    // content id
    if (str.substr(0, 3) !== 'NIL') {
      lastIndex = getLastIdxQuoted(str);
      part.id = str.substring(1, lastIndex);
      str = str.substr(lastIndex+1).trim();
    } else
      str = str.substr(4);

    // content description
    if (str.substr(0, 3) !== 'NIL') {
      lastIndex = getLastIdxQuoted(str);
      part.description = str.substring(1, lastIndex);
      str = str.substr(lastIndex+1).trim();
    } else
      str = str.substr(4);

    // content encoding
    if (str.substr(0, 3) !== 'NIL') {
      lastIndex = getLastIdxQuoted(str);
      part.encoding = str.substring(1, lastIndex);
      str = str.substr(lastIndex+1).trim();
    } else
      str = str.substr(4);

    // size of content encoded in bytes
    if (str.substr(0, 3) !== 'NIL') {
      lastIndex = 0;
      while (str.charCodeAt(lastIndex) >= 48 && str.charCodeAt(lastIndex) <= 57)
        lastIndex++;
      part.size = parseInt(str.substring(0, lastIndex));
      str = str.substr(lastIndex).trim();
    } else
      str = str.substr(4);

    // [# of lines]
    if (part.type.name.indexOf('text/') === 0) {
      if (str.substr(0, 3) !== 'NIL') {
        lastIndex = 0;
        while (str.charCodeAt(lastIndex) >= 48 && str.charCodeAt(lastIndex) <= 57)
          lastIndex++;
        part.lines = parseInt(str.substring(0, lastIndex));
        str = str.substr(lastIndex).trim();
      } else
        str = str.substr(4);
    }

    // [md5 hash of content]
    if (str.length > 0) {
      if (str.substr(0, 3) !== 'NIL') {
        lastIndex = getLastIdxQuoted(str);
        part.md5 = str.substring(1, lastIndex);
        str = str.substr(lastIndex+1).trim();
      } else
        str = str.substr(4);

      // [disposition]
      if (str.length > 0) {
        if (str.substr(0, 3) !== 'NIL') {
          part.disposition = { type: null, params: null };
          str = str.substr(1);
          lastIndex = getLastIdxQuoted(str);
          part.disposition.type = str.substring(1, lastIndex).toLowerCase();
          str = str.substr(lastIndex+1).trim();
          if (str[0] === '(') {
            var isKey = true, key;
            str = str.substr(1);
            part.disposition.params = {};
            while (str[0] !== ')') {
              lastIndex = getLastIdxQuoted(str);
              if (isKey)
                key = str.substring(1, lastIndex).toLowerCase();
              else
                part.disposition.params[key] = str.substring(1, lastIndex);
              str = str.substr(lastIndex+1).trim();
              isKey = !isKey;
            }
            str = str.substr(2).trim();
          } else
            str = str.substr(4).trim();
        } else
          str = str.substr(4);

        // [language]
        if (str.length > 0) {
          if (str.substr(0, 3) !== 'NIL') {
            if (str[0] === '(') {
              part.language = [];
              str = str.substr(1);
              while (str[0] !== ')') {
                lastIndex = getLastIdxQuoted(str);
                part.language.push(str.substring(1, lastIndex));
                str = str.substr(lastIndex+1).trim();
              }
            } else {
              lastIndex = getLastIdxQuoted(str);
              part.language = [str.substring(1, lastIndex)];
              str = str.substr(lastIndex+1).trim();
            }
          } else
            str = str.substr(4);

          // [location]
          if (str.length > 0) {
            if (str.substr(0, 3) !== 'NIL') {
              lastIndex = getLastIdxQuoted(str);
              part.location = str.substring(1, lastIndex);
              str = str.substr(lastIndex+1).trim();
            } else
              str = str.substr(4);
          }
        }
      }
    }

    retVal.push(part);
  }
  return retVal;
}

String.prototype.explode = function(delimiter, limit) {
  if (arguments.length < 2 || arguments[0] === undefined || arguments[1] === undefined ||
      !delimiter || delimiter === '' || typeof delimiter === 'function' || typeof delimiter === 'object')
      return false;

	delimiter = (delimiter === true ? '1' : delimiter.toString());

  if (!limit || limit === 0)
    return this.split(delimiter);
  else if (limit < 0)
		return false;
	else if (limit > 0) {
    var splitted = this.split(delimiter);
    var partA = splitted.splice(0, limit - 1);
    var partB = splitted.join(delimiter);
    partA.push(partB);
    return partA;
  }

	return false;
}

function isNotEmpty(str) {
	return str.trim().length > 0;
}

function escape(str) {
  return str.replace('\\', '\\\\').replace('"', '\"');
}

function unescape(str) {
  return str.replace('\"', '"').replace('\\\\', '\\');
}

function up(str) {
  return str.toUpperCase();
}

function getLastIdxQuoted(str) {
  var index = -1, countQuote = 0;
  for (var i=0,len=str.length; i<len; i++) {
    if (str[i] === '"') {
      if (i > 0 && str[i-1] === "\\")
        continue;
      countQuote++;
    }
    if (countQuote === 2) {
      index = i;
      break;
    }
  }
  return index;
}

/**
 * Adopted from jquery's extend method. Under the terms of MIT License.
 *
 * http://code.jquery.com/jquery-1.4.2.js
 *
 * Modified by Brian White to use Array.isArray instead of the custom isArray method
 */
function extend() {
  // copy reference to target object
  var target = arguments[0] || {}, i = 1, length = arguments.length, deep = false, options, name, src, copy;

  // Handle a deep copy situation
  if ( typeof target === "boolean" ) {
      deep = target;
      target = arguments[1] || {};
      // skip the boolean and the target
      i = 2;
  }

  // Handle case when target is a string or something (possible in deep copy)
  if ( typeof target !== "object" && !typeof target === 'function') {
      target = {};
  }

  var isPlainObject = function( obj ) {
    // Must be an Object.
    // Because of IE, we also have to check the presence of the constructor property.
    // Make sure that DOM nodes and window objects don't pass through, as well
    if ( !obj || toString.call(obj) !== "[object Object]" || obj.nodeType || obj.setInterval )
      return false;
    
    var has_own_constructor = hasOwnProperty.call(obj, "constructor");
    var has_is_property_of_method = hasOwnProperty.call(obj.constructor.prototype, "isPrototypeOf");
    // Not own constructor property must be Object
    if ( obj.constructor && !has_own_constructor && !has_is_property_of_method)
      return false;
    
    // Own properties are enumerated firstly, so to speed up,
    // if last one is own, then all properties are own.

    var last_key;
    for ( key in obj )
      last_key = key;
    
    return typeof last_key === "undefined" || hasOwnProperty.call( obj, last_key );
  };


  for ( ; i < length; i++ ) {
    // Only deal with non-null/undefined values
    if ( (options = arguments[ i ]) !== null ) {
      // Extend the base object
      for ( name in options ) {
        src = target[ name ];
        copy = options[ name ];

        // Prevent never-ending loop
        if ( target === copy )
            continue;

        // Recurse if we're merging object literal values or arrays
        if ( deep && copy && ( isPlainObject(copy) || Array.isArray(copy) ) ) {
          var clone = src && ( isPlainObject(src) || Array.isArray(src) ) ? src : Array.isArray(copy) ? [] : {};

          // Never move original objects, clone them
          target[ name ] = extend( deep, clone, copy );

        // Don't bring in undefined values
        } else if ( typeof copy !== "undefined" )
          target[ name ] = copy;
      }
    }
  }

  // Return the modified object
  return target;
};