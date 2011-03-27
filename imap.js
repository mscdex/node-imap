var util = require('util'), net = require('net'),
    tls = require('tls'), EventEmitter = require('events').EventEmitter;
var emptyFn = function() {}, CRLF = "\r\n", debug=emptyFn,
    STATES = {
      NOCONNECT: 0,
      NOAUTH: 1,
      AUTH: 2,
      BOXSELECTING: 3,
      BOXSELECTED: 4
    }, BOX_ATTRIBS = ['NOINFERIORS', 'NOSELECT', 'MARKED', 'UNMARKED'];

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
    curData: '',
    curExpected: 0,
    curXferred: 0,
    capabilities: [],
    box: {
      _uidnext: 0,
      _flags: [],
      _newKeywords: false,
      validity: 0,
      keywords: [],
      permFlags: [],
      name: null,
      messages: { total: 0, new: 0 }
    }
  };
  this._options = extend(true, this._options, options);

  if (typeof this._options.debug === 'function')
    debug = this._options.debug;
  this.delim = null;
  this.namespaces = { personal: [], other: [], shared: [] };
};
util.inherits(ImapConnection, EventEmitter);
exports.ImapConnection = ImapConnection;

ImapConnection.prototype.connect = function(loginCb) {
  var self = this,
      fnInit = function() {
        // First get pre-auth capabilities, including server-supported auth mechanisms
        self._send('CAPABILITY', function() {
          // Next, attempt to login
          self._login(function(err, reentry) {
            if (err) {
              loginCb(err);
              return;
            }
            // Next, get the list of available namespaces if supported
            if (!reentry && self._state.capabilities.indexOf('NAMESPACE') > -1) {
              var fnMe = arguments.callee;
              // Re-enter this function after we've obtained the available namespaces
              self._send('NAMESPACE', function(e) { fnMe.call(this, e, true); });
              return;
            }
            // Lastly, get the top-level mailbox hierarchy delimiter used by the server
            self._send('LIST "" ""', loginCb);
          });
        });
      };
  loginCb = loginCb || emptyFn;
  this._reset();

  this._state.conn = net.createConnection(this._options.port, this._options.host);

  this._state.tmrConn = setTimeout(this._fnTmrConn, this._options.connTimeout, loginCb);
  this._state.conn.setKeepAlive(true);

  if (this._options.secure) {
    // TODO: support STARTTLS
    this._state.conn.cleartext = this._state.conn.setSecure();
    this._state.conn.on('secure', function() {
      debug('Secure connection made.');
    });
    this._state.conn.cleartext.setEncoding('utf8');
  } else {
    this._state.conn.setEncoding('utf8');
    this._state.conn.cleartext = this._state.conn;
  }

  this._state.conn.on('connect', function() {
    clearTimeout(self._state.tmrConn);
    debug('Connected to host.');
    self._state.conn.cleartext.write('');
    self._state.status = STATES.NOAUTH;
  });
  this._state.conn.on('ready', function() {
    fnInit();
  });
  this._state.conn.cleartext.on('data', function(data) {
    var trailingCRLF = false, literalInfo, bypass = false;
    debug('<<RECEIVED>>: ' + util.inspect(data));

    if (self._state.curExpected === 0) {
      if (data.indexOf(CRLF) === -1) {
        self._state.curData += data;
        return;
      }
      if (self._state.curData.length) {
        data = self._state.curData + data;
        self._state.curData = '';
      }
    }

    // Don't mess with incoming data if it's part of a literal
    if (self._state.curExpected > 0) {
      var extra = '', curReq = self._state.requests[0];
      if (!curReq._done) {
        self._state.curXferred += Buffer.byteLength(data, 'utf8');
        if (self._state.curXferred <= self._state.curExpected) {
          if (curReq._msgtype === 'headers')
            // buffer headers since they're generally not large and are
            // processed anyway
            self._state.curData += data;
          else
            curReq._msg.emit('data', data);
          return;
        }
        var pos = Buffer.byteLength(data, 'utf8')-(self._state.curXferred-self._state.curExpected);
        extra = (new Buffer(data)).slice(pos).toString('utf8');
        if (pos > 0) {
          if (curReq._msgtype === 'headers') {
            self._state.curData += (new Buffer(data)).slice(0, pos).toString('utf8');
            curReq._msgheaders = self._state.curData;
          } else
            curReq._msg.emit('data', (new Buffer(data)).slice(0, pos).toString('utf8'));
        }
        self._state.curData = '';
        data = extra;
        curReq._done = true;
      }
      // make sure we have at least ")\r\n" in the post-literal data
      if (data.indexOf(CRLF) === -1) {
        self._state.curData += data;
        return;
      }
      if (self._state.curData.length)
        data = self._state.curData + data;
      // add any additional k/v pairs that appear after the literal data
      var fetchdesc = curReq._fetchdesc + data.substring(0, data.indexOf(CRLF)-1).trim();
      parseFetch(fetchdesc, curReq._msgheaders, curReq._msg);
      data = data.substr(data.indexOf(CRLF)+2);
      self._state.curExpected = 0;
      self._state.curXferred = 0;
      self._state.curData = '';
      curReq._done = false;
      curReq._msg.emit('end');
      if (data[0] === '*') {
        // found additional responses, so don't try splitting the proceeding
        // response(s) for better performance in case they have literals too
        process.nextTick(function() { self._state.conn.cleartext.emit('data', data); });
        return;
      }
    } else if (self._state.curExpected === 0
               && (literalInfo = /\{(\d+)\}$/.exec(data.substr(0, data.indexOf(CRLF))))) {
      self._state.curExpected = parseInt(literalInfo[1]);
      var curReq = self._state.requests[0];
      //if (/^UID FETCH/.test(curReq.command)) {
        var type = /BODY\[(.*)\](?:\<[\d]+\>)?/.exec(data.substr(0, data.indexOf(CRLF))),
            msg = new ImapMessage();
        type = type[1];
        parseFetch(data.substring(data.indexOf("(")+1, data.indexOf(CRLF)), "", msg);
        curReq._fetchdesc = data.substring(data.indexOf("(")+1, data.indexOf(CRLF));
        curReq._msg = msg;
        curReq._fetcher.emit('message', msg);
        curReq._msgtype = (type.indexOf('HEADER') === 0 ? 'headers' : 'body');
        self._state.conn.cleartext.emit('data', data.substr(data.indexOf(CRLF)+2));
      //}
      return;
    }

    if (data.length === 0)
      return;
    data = data.split(CRLF).filter(isNotEmpty);

    // Defer any extra server responses found in the incoming data
    if (data.length > 1) {
      data.slice(1).forEach(function(line) {
        process.nextTick(function() {
          self._state.conn.cleartext.emit('data', line + CRLF);
        });
      });
    }

    data = data[0].explode(' ', 3);

    if (data[0] === '*') { // Untagged server response
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
        if (data[1] !== 'CAPABILITY' && data[1] !== 'ALERT')
          return;
      }
      switch (data[1]) {
        case 'CAPABILITY':
          if (self._state.numCapRecvs < 2)
            self._state.numCapRecvs++;
          self._state.capabilities = data[2].split(' ').map(up);
        break;
        case 'FLAGS':
          if (self._state.status === STATES.BOXSELECTING)
            self._state.box._flags = data[2].substr(1, data[2].length-2).split(' ').map(function(flag) {return flag.substr(1);});;
        break;
        case 'OK':
          if ((result = /^\[ALERT\] (.*)$/i.exec(data[2])) !== null)
            self.emit('alert', result[1]);
          else if (self._state.status === STATES.BOXSELECTING) {
            var result;
            if ((result = /^\[UIDVALIDITY (\d+)\]$/i.exec(data[2])) !== null)
              self._state.box.validity = result[1];
            else if ((result = /^\[UIDNEXT (\d+)\]$/i.exec(data[2])) !== null)
              self._state.box._uidnext = result[1];
            else if ((result = /^\[PERMANENTFLAGS \((.*)\)\]$/i.exec(data[2])) !== null) {
              self._state.box.permFlags = result[1].split(' ');
              var idx;
              if ((idx = self._state.box.permFlags.indexOf('\\*')) > -1) {
                self._state.box._newKeywords = true;
                self._state.box.permFlags.splice(idx, 1);
              }
              self._state.box.keywords = self._state.box.permFlags.filter(function(flag) {return flag[0] !== '\\';});
              for (var i=0; i<self._state.box.keywords.length; i++)
                self._state.box.permFlags.splice(self._state.box.permFlags.indexOf(self._state.box.keywords[i]), 1);
              self._state.box.permFlags = self._state.box.permFlags.map(function(flag) {return flag.substr(1);});
            }
          }
        break;
        case 'NAMESPACE':
          parseNamespaces(data[2], self.namespaces);
        break;
        case 'SEARCH':
          self._state.requests[0].args.push((typeof data[2] === 'undefined' || data[2].length === 0 ? [] : data[2].split(' ')));
        break;
        /*case 'STATUS':
          var result = /UIDNEXT ([\d]+)\)$/.exec(data[2]);
          self._state.requests[0].args.push(parseInt(result[1]));
        break;*/
        case 'LIST':
          var result;
          if (self.delim === null && (result = /^\(\\Noselect\) (.+?) ".*"$/.exec(data[2])) !== null)
            self.delim = (result[1] === 'NIL' ? false : result[1].substring(1, result[1].length-1));
          else if (self.delim !== null) {
            if (self._state.requests[0].args.length === 0)
              self._state.requests[0].args.push({});
            result = /^\((.*)\) (.+?) "(.+)"$/.exec(data[2]);
            var box = {
              attribs: result[1].split(' ').map(function(attrib) {return attrib.substr(1).toUpperCase();})
                                .filter(function(attrib) {return BOX_ATTRIBS.indexOf(attrib) > -1;}),
              delim: (result[2] === 'NIL' ? false : result[2].substring(1, result[2].length-1)),
              children: null,
              parent: null
            }, name = result[3], curChildren = self._state.requests[0].args[0];

            if (box.delim) {
              var path = name.split(box.delim).filter(isNotEmpty), parent = null;
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
            curChildren[name] = box;
          }
        break;
        default:
          if (/^\d+$/.test(data[1])) {
            switch (data[2]) {
              case 'EXISTS': // mailbox total message count
                var prev = self._state.box.messages.total,
                    now = parseInt(data[1]);
                self._state.box.messages.total = now;
                if (self._state.status !== STATES.BOXSELECTING && now > prev) {
                  self._state.box.messages.new = now-prev;
                  self.emit('mail', self._state.box.messages.new); // new mail notification
                }
              break;
              case 'RECENT': // messages marked with the \Recent flag (i.e. new messages)
                self._state.box.messages.new = parseInt(data[1]);
              break;
              case 'EXPUNGE': // confirms permanent deletion of a single message
                if (self._state.box.messages.total > 0)
                  self._state.box.messages.total--;
              break;
              default:
                if (/^FETCH/.test(data[2])) { // fetches without header or body (part) retrievals
                  var curReq = self._state.requests[0],
                      msg = new ImapMessage();
                  parseFetch(data[2].substring(data[2].indexOf("(")+1, data[2].lastIndexOf(")")), "", msg);
                  curReq._fetcher.emit('message', msg);
                  msg.emit('end');
                }
              break;
            }
          }
      }
    } else if (data[0].indexOf('A') === 0) { // Tagged server response
      var sendBox = false;
      clearTimeout(self._state.tmrKeepalive);
      self._state.tmrKeepalive = setTimeout(self._idleCheck.bind(self), self._state.tmoKeepalive);

      if (self._state.status === STATES.BOXSELECTING) {
        if (data[1] === 'OK') {
          sendBox = true;
          self._state.status = STATES.BOXSELECTED;
        } else {
          self._state.status = STATES.AUTH;
          self._resetBox();
        }
      }
      
      if (self._state.requests.length > 0) {
        if (self._state.requests[0].command.indexOf('RENAME') > -1) {
          self._state.box.name = self._state.box._newName;
          delete self._state.box._newName;
          sendBox = true;
        }
        
        if (typeof self._state.requests[0].callback === 'function') {
          var err = null;
          var args = self._state.requests[0].args, cmd = self._state.requests[0].command;
          if (data[1] !== 'OK') {
            err = new Error('Error while executing request: ' + data[2]);
            err.type = data[1];
            err.request = cmd;
          } else if (self._state.status === STATES.BOXSELECTED) {
            if (sendBox) // SELECT, EXAMINE, RENAME
              args.unshift(self._state.box);
            // According to RFC3501, UID commands do not give errors for non-existant user-supplied UIDs,
            // so give the callback empty results if we unexpectedly received no untagged responses.
            else if ((cmd.indexOf('UID FETCH') === 0 || cmd.indexOf('UID SEARCH') === 0) && args.length === 0)
              args.unshift([]);
          }
          args.unshift(err);
          self._state.requests[0].callback.apply({}, args);
        } else if (self._state.requests[0].command.indexOf("UID FETCH") === 0)
          self._state.requests[0]._fetcher.emit('end');
      }

      self._state.requests.shift();
      process.nextTick(function() { self._send(); });
      self._state.isIdle = true;
    } else {
      // unknown response
    }
  });
  this._state.conn.on('end', function() {
    self._reset();
    debug('FIN packet received. Disconnecting...');
    self.emit('end');
  });
  this._state.conn.on('error', function(err) {
    clearTimeout(self._state.tmrConn);
    if (self._state.status === STATES.NOCONNECT)
      loginCb(new Error('Unable to connect. Reason: ' + err));
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
  if (this._state.status === STATES.BOXSELECTED)
    this._resetBox();
  if (typeof cb === 'undefined') {
    if(typeof readOnly === 'undefined') {
      cb = emptyFn;
    } else {
      cb = readOnly;
    }
    readOnly = false;
  }
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

ImapConnection.prototype.removeDeleted = function(cb) {
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  cb = arguments[arguments.length-1];

  this._send('EXPUNGE', cb);
};

ImapConnection.prototype.getBoxes = function(namespace, cb) {
  cb = arguments[arguments.length-1];
  if (arguments.length !== 2)
    namespace = '';
  this._send('LIST "' + escape(namespace) + '" "*"', cb);
};

ImapConnection.prototype.addBox = function(name, cb) {
  cb = arguments[arguments.length-1];
  if (typeof name !== 'string' || name.length === 0)
    throw new Error('Mailbox name must be a string describing the full path of a new mailbox to be created');
  this._send('CREATE "' + escape(name) + '"', cb);
};

ImapConnection.prototype.delBox = function(name, cb) {
  cb = arguments[arguments.length-1];
  if (typeof name !== 'string' || name.length === 0)
    throw new Error('Mailbox name must be a string describing the full path of an existing mailbox to be deleted');
  this._send('DELETE "' + escape(name) + '"', cb);
};

ImapConnection.prototype.renameBox = function(oldname, newname, cb) {
  cb = arguments[arguments.length-1];
  if (typeof oldname !== 'string' || oldname.length === 0)
    throw new Error('Old mailbox name must be a string describing the full path of an existing mailbox to be renamed');
  else if (typeof newname !== 'string' || newname.length === 0)
    throw new Error('New mailbox name must be a string describing the full path of a new mailbox to be renamed to');
  if (this._state.status === STATES.BOXSELECTED && oldname === this._state.box.name && oldname !== 'INBOX')
    this._state.box._newName = oldname;
    
  this._send('RENAME "' + escape(oldname) + '" "' + escape(newname) + '"', cb);
};

ImapConnection.prototype.search = function(options, cb) {
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  if (!Array.isArray(options))
    throw new Error('Expected array for search options');
  this._send('UID SEARCH' + buildSearchQuery(options), cb);
};

ImapConnection.prototype.fetch = function(uids, options) {
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  if (!Array.isArray(uids))
    uids = [uids];
  try {
    validateUIDList(uids);
  } catch(e) {
    throw e;
  }
  var defaults = {
    markSeen: false,
    request: {
      struct: true,
      headers: true, // \_______ at most one of these can be used for any given fetch request
      body: false   //  /
    }
  }, toFetch, bodyRange = '';
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

  this._send('UID FETCH ' + uids.join(',') + ' (FLAGS INTERNALDATE'
             + (options.request.struct ? ' BODYSTRUCTURE' : '')
             + (toFetch ? ' BODY' + (!options.markSeen ? '.PEEK' : '')
             + '[' + toFetch + ']' + bodyRange : '') + ')');
  var imapFetcher = new ImapFetch();
  this._state.requests[this._state.requests.length-1]._fetcher = imapFetcher;
  return imapFetcher;
};

ImapConnection.prototype.addFlags = function(uids, flags, cb) {
  try {
    this._store(uids, flags, true, cb);
  } catch (err) {
    throw err;
  }
};

ImapConnection.prototype.delFlags = function(uids, flags, cb) {
  try {
    this._store(uids, flags, false, cb);
  } catch (err) {
    throw err;
  }
};

ImapConnection.prototype.addKeywords = function(uids, flags, cb) {
  if (!self._state.box._newKeywords)
    throw new Error('This mailbox does not allow new keywords to be added');
  try {
    this._store(uids, flags, true, cb);
  } catch (err) {
    throw err;
  }
};

ImapConnection.prototype.delKeywords = function(uids, flags, cb) {
  try {
    this._store(uids, flags, false, cb);
  } catch (err) {
    throw err;
  }
};

ImapConnection.prototype.copy = function(uids, boxTo, cb) {
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  if (!Array.isArray(uids))
    uids = [uids];
  try {
    validateUIDList(uids);
  } catch(e) {
    throw e;
  }
  this._send('UID COPY ' + uids.join(',') + ' "' + escape(boxTo) + '"', cb);
};

ImapConnection.prototype.move = function(uids, boxTo, cb) {
  var self = this;
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  if (self._state.box.permFlags.indexOf('Deleted') === -1)
    cb(new Error('Cannot move message: server does not allow deletion of messages'));
  else {
    self.copy(uids, boxTo, function(err, reentryCount, deletedUIDs, counter) {
      if (err) {
        cb(err);
        return;
      }

      var fnMe = arguments.callee;
      counter = counter || 0;
      // Make sure we don't expunge any messages marked as Deleted except the one we are moving
      if (typeof reentryCount === 'undefined')
        self.search(['DELETED'], function(e, result) { fnMe.call(this, e, 1, result); });
      else if (reentryCount === 1) {
        if (counter < deletedUIDs.length)
          self.delFlags(deletedUIDs[counter], 'DELETED', function(e) { process.nextTick(function(){fnMe.call(this, e, reentryCount, deletedUIDs, counter+1);}); });
        else
          fnMe.call(this, err, reentryCount+1, deletedUIDs);
      } else if (reentryCount === 2)
        self.addFlags(uids, 'Deleted', function(e) { fnMe.call(this, e, reentryCount+1, deletedUIDs); });
      else if (reentryCount === 3)
        self.removeDeleted(function(e) { fnMe.call(this, e, reentryCount+1, deletedUIDs); });
      else if (reentryCount === 4) {
        if (counter < deletedUIDs.length)
          self.addFlags(deletedUIDs[counter], 'DELETED', function(e) { process.nextTick(function(){fnMe.call(this, e, reentryCount, deletedUIDs, counter+1);}); });
        else
          cb();
      }
    });
  }
};


/****** Private Functions ******/

ImapConnection.prototype._fnTmrConn = function(loginCb) {
  loginCb(new Error('Connection timed out'));
  this._state.conn.destroy();
}

ImapConnection.prototype._store = function(uids, flags, isAdding, cb) {
  var isKeywords = (arguments.callee.caller === this.addKeywords || arguments.callee.caller === this.delKeywords);
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  if (typeof uids === 'undefined')
    throw new Error('The message ID(s) must be specified');
  if (!Array.isArray(uids))
    uids = [uids];
  try {
    validateUIDList(uids);
  } catch(e) {
    throw e;
  }
  if ((!Array.isArray(flags) && typeof flags !== 'string') || (Array.isArray(flags) && flags.length === 0))
    throw new Error((isKeywords ? 'Keywords' : 'Flags') + ' argument must be a string or a non-empty Array');
  if (!Array.isArray(flags))
    flags = [flags];
  for (var i=0; i<flags.length; i++) {
    if (!isKeywords) {
      if (this._state.box.permFlags.indexOf(flags[i]) === -1 || flags[i] === '\\*' || flags[i] === '*')
        throw new Error('The flag "' + flags[i] + '" is not allowed by the server for this mailbox');
    } else {
      // keyword contains any char except control characters (%x00-1F and %x7F) and: '(', ')', '{', ' ', '%', '*', '\', '"', ']'
      if (/[\(\)\{\\\"\]\%\*\x00-\x20\x7F]/.test(flags[i]))
        throw new Error('The keyword "' + flags[i] + '" contains invalid characters');
    }
  }
  if (!isKeywords)
    flags = flags.map(function(flag) {return '\\' + flag;})
  flags = flags.join(' ');
  cb = arguments[arguments.length-1];

  this._send('UID STORE ' + uids.join(',') + ' ' + (isAdding ? '+' : '-') + 'FLAGS.SILENT (' + flags + ')', cb);
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
    if (typeof this._state.capabilities.LOGINDISABLED !== 'undefined') {
      cb(new Error('Logging in is disabled on this server'));
      return;
    }
    //if (typeof this._state.capabilities['AUTH=PLAIN'] !== 'undefined') {
      this._send('LOGIN "' + escape(this._options.username) + '" "' + escape(this._options.password) + '"', fnReturn);
    /*} else {
      cb(new Error('Unsupported authentication mechanism(s) detected. Unable to login.'));
      return;
    }*/
  }
};
ImapConnection.prototype._reset = function() {
  clearTimeout(this._state.tmrKeepalive);
  clearTimeout(this._state.tmrConn);
  this._state.status = STATES.NOCONNECT;
  this._state.numCapRecvs = 0;
  this._state.requests = [];
  this._state.capabilities = [];
  this._state.isIdle = true;
  this._state.isReady = false;
  this.namespaces = { personal: [], other: [], shared: [] };
  this.delim = null;
  this._resetBox();
};
ImapConnection.prototype._resetBox = function() {
  this._state.box._uidnext = 0;
  this._state.box.validity = 0;
  this._state.box._flags = [];
  this._state.box._newKeywords = false;
  this._state.box.permFlags = [];
  this._state.box.keywords = [];
  this._state.box.name = null;
  this._state.box.messages.total = 0;
  this._state.box.messages.new = 0;
};
ImapConnection.prototype._idleCheck = function() {
  if (this._state.isIdle)
    this._noop();
};
ImapConnection.prototype._noop = function() {
  if (this._state.status >= STATES.AUTH)
    this._send('NOOP', undefined);
};
ImapConnection.prototype._send = function(cmdstr, cb, bypass) {
  if (arguments.length > 0 && !bypass)
    this._state.requests.push({ command: cmdstr, callback: cb, args: [] });
  if ((arguments.length === 0 && this._state.requests.length > 0) || this._state.requests.length === 1 || bypass) {
    clearTimeout(this._state.tmrKeepalive);
    this._state.isIdle = false;
    var cmd = (bypass ? cmdstr : this._state.requests[0].command);
    this._state.conn.cleartext.write('A' + ++this._state.curId + ' ' + cmd + CRLF);
    debug('<<SENT>>: A' + this._state.curId + ' ' + cmd);
  }
};

function ImapMessage() {}
util.inherits(ImapMessage, EventEmitter);
function ImapFetch() {}
util.inherits(ImapFetch, EventEmitter);

/****** Utility Functions ******/

function buildSearchQuery(options, isOrChild) {
  var searchargs = '', months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (var i=0,len=options.length; i<len; i++) {
    var criteria = (isOrChild ? options : options[i]), args = null, modifier = (isOrChild ? '' : ' ');
    if (typeof criteria === 'string')
      criteria = criteria.toUpperCase();
    else if (Array.isArray(criteria)) {
      if (criteria.length > 1)
        args = criteria.slice(1);
      if (criteria.length > 0)
        criteria = criteria[0].toUpperCase();
    } else
      throw new Error('Unexpected search option data type. Expected string or array. Got: ' + typeof criteria);
    if (criteria === 'OR') {
      if (args.length !== 2)
        throw new Error('OR must have exactly two arguments');
      searchargs += ' OR (' + buildSearchQuery(args[0], true) + ') (' + buildSearchQuery(args[1], true) + ')'
    } else {
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
              throw new Error('Search option argument must be a Date object or a parseable date string');
          }
          searchargs += modifier + criteria + ' ' + args[0].getDate() + '-' + months[args[0].getMonth()] + '-' + args[0].getFullYear();
        break;
        case 'KEYWORD':
        case 'UNKEYWORD':
          if (!args || args.length !== 1)
            throw new Error('Incorrect number of arguments for search option: ' + criteria);
          searchargs += modifier + criteria + ' ' + args[0];
        break;
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
        case 'UID':
          if (!args)
            throw new Error('Incorrect number of arguments for search option: ' + criteria);
          args = args.slice(1);
          try {
            validateUIDList(args);
          } catch(e) {
            throw e;
          }
          searchargs += modifier + criteria + ' ' + args.join(',');
        break;
        default:
          throw new Error('Unexpected search option: ' + criteria);
      }
    }
    if (isOrChild)
      break;
  }
  return searchargs;
}

function validateUIDList(uids) {
  for (var i=0,len=uids.length,intval; i<len; i++) {
    if (typeof uids[i] === 'string') {
      if (uids[i] === '*' || uids[i] === '*:*') {
        if (len > 1)
          uids = ['*'];
        break;
      } else if (/^(?:[\d]+|\*):(?:[\d]+|\*)$/.test(uids[i]))
        continue;
    }
    intval = parseInt(''+uids[i]);
    if (isNaN(intval))
      throw new Error('Message ID must be an integer, "*", or a range: ' + uids[i]);
    else if (typeof uids[i] !== 'number')
      uids[i] = intval;
  }
}

function parseNamespaces(str, namespaces) {
  // str contains 3 parenthesized lists (or NIL) describing the personal, other users', and shared namespaces available
  var idxNext, idxNextName, idxNextVal, strNamespace, strList, details, types = Object.keys(namespaces), curType = 0;
  while (str.length > 0) {
    if (str.substr(0, 3) === 'NIL')
      idxNext = 3;
    else {
      idxNext = getNextIdxParen(str)+1;

      // examples: (...)
      //           (...)(...)
      strList = str.substring(1, idxNext-1);

      // parse each namespace for the current type
      while (strList.length > 0) {
        details = {};
        idxNextName = getNextIdxParen(strList)+1;

        // examples: "prefix" "delimiter"
        //           "prefix" NIL
        //           "prefix" NIL "X-SOME-EXT" ("FOO" "BAR" "BAZ")
        strNamespace = strList.substring(1, idxNextName-1);

        // prefix
        idxNextVal = getNextIdxQuoted(strNamespace)+1;
        details.prefix = strNamespace.substring(1, idxNextVal-1);
        strNamespace = strNamespace.substr(idxNextVal).trim();

        // delimiter
        if (strNamespace.substr(0, 3) === 'NIL') {
          details.delim = false;
          strNamespace = strNamespace.substr(3).trim();
        } else {
          idxNextVal = getNextIdxQuoted(strNamespace)+1;
          details.delim = strNamespace.substring(1, idxNextVal-1);
          strNamespace = strNamespace.substr(idxNextVal).trim();
        }

        // [extensions]
        if (strNamespace.length > 0) {
          details.extensions = [];
          var extension;
          while (strNamespace.length > 0) {
            extension = { name: '', params: null };
            
            // name
            idxNextVal = getNextIdxQuoted(strNamespace)+1;
            extension.name = strNamespace.substring(1, idxNextVal-1);
            strNamespace = strNamespace.substr(idxNextVal).trim();
            
            // params
            idxNextVal = getNextIdxParen(strNamespace)+1;
            var strParams = strNamespace.substring(1, idxNextVal-1), idxNextParam;
            if (strParams.length > 0) {
              extension.params = [];
              while (strParams.length > 0) {
                idxNextParam = getNextIdxQuoted(strParams)+1;
                extension.params.push(strParams.substring(1, idxNextParam-1));
                strParams = strParams.substr(idxNextParam).trim();
              }
            }
            strNamespace = strNamespace.substr(idxNextVal).trim();

            details.extensions.push(extension);
          }
        } else
          details.extensions = null;

        namespaces[types[curType]].push(details);
        strList = strList.substr(idxNextName).trim();
      }
      curType++;
    }
    str = str.substr(idxNext).trim();
  }
}

function parseFetch(str, literalData, fetchData) {
  // str === "... {xxxx}" or "... {xxxx} ..." or just "..."
  // where ... is any number of key-value pairs
  // and {xxxx} is the byte count for the literalData describing the preceding item (almost always "BODY")
  var key, idxNext;
  while (str.length > 0) {
    key = (str.substr(0, 5) === 'BODY[' ?
             str.substring(0,
              (str.indexOf('>') > -1 ? str.indexOf('>') : str.indexOf(']'))+1)
           : str.substring(0, str.indexOf(' ')));
    str = str.substring(str.indexOf(' ')+1);
    if (str.substr(0, 3) === 'NIL')
      idxNext = 3;
    else {
      switch (key) {
        case 'UID':
          idxNext = str.indexOf(' ')+1;
          fetchData.id = parseInt(str.substring(0, idxNext-1));
        break;
        case 'INTERNALDATE':
          idxNext = str.indexOf('"', 1)+1;
          fetchData.date = str.substring(1, idxNext-1);
        break;
        case 'FLAGS':
          idxNext = str.indexOf(')')+1;
          fetchData.flags = str.substring(1, idxNext-1).split(' ').filter(isNotEmpty);
        break;
        case 'BODYSTRUCTURE':
          idxNext = getNextIdxParen(str)+1;
          fetchData.structure = parseBodyStructure(str.substring(1, idxNext-1));
        break;
        default:
          var result = /^BODY\[(.*)\](?:\<[\d]+\>)?$/.exec(key);
          idxNext = str.indexOf("}")+1;
          if (result && result[1].indexOf('HEADER') === 0) { // either full or selective headers
            var headers = literalData.split(/\r\n(?=[\w])/), header;
            fetchData.headers = {};
            for (var i=0,len=headers.length; i<len; i++) {
              header = headers[i].substr(0, headers[i].indexOf(': ')).toLowerCase();
              if (!fetchData.headers[header])
                fetchData.headers[header] = [];
              fetchData.headers[header].push(headers[i].substr(headers[i].indexOf(': ')+2).replace(/\r\n/g, '').trim());
            }
          }
      }
    }
    str = str.substr(idxNext).trim();
  }
}

function parseBodyStructure(str, prefix, partID) {
  var retVal = [], lastIndex;
  prefix = (prefix !== undefined ? prefix : '');
  partID = (partID !== undefined ? partID : 1);
  if (str[0] === '(') { // multipart
    var extensionData = {
      type: null, // required
      params: null, disposition: null, language: null, location: null // optional and may be omitted completely
    };
    // Recursively parse each part
    while (str[0] === '(') {
      lastIndex = getNextIdxParen(str);
      retVal.push(parseBodyStructure(str.substr(1, lastIndex-1), prefix + (prefix !== '' ? '.' : '') + (partID++).toString(), 1));
      str = str.substr(lastIndex+1).trim();
    }

    // multipart type
    lastIndex = getNextIdxQuoted(str);
    extensionData.type = str.substring(1, lastIndex).toLowerCase();
    str = str.substr(lastIndex+1).trim();

    // [parameters]
    if (str.length > 0) {
      if (str[0] === '(') {
        var isKey = true, key;
        str = str.substr(1);
        extensionData.params = {};
        while (str[0] !== ')') {
          lastIndex = getNextIdxQuoted(str);
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
          lastIndex = getNextIdxQuoted(str);
          extensionData.disposition.type = str.substring(1, lastIndex).toLowerCase();
          str = str.substr(lastIndex+1).trim();
          if (str[0] === '(') {
            var isKey = true, key;
            str = str.substr(1);
            extensionData.disposition.params = {};
            while (str[0] !== ')') {
              lastIndex = getNextIdxQuoted(str);
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
            lastIndex = getNextIdxQuoted(str);
            extensionData.language = str.substring(1, lastIndex);
            str = str.substr(lastIndex+1).trim();
          } else
            str = str.substr(4);

          // [location]
          if (str.length > 0) {
            if (str.substr(0, 3) !== 'NIL') {
              lastIndex = getNextIdxQuoted(str);
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
        lastIndex = getNextIdxQuoted(str),
        contentTypeMain = str.substring(1, lastIndex),
        contentTypeSub;
    str = str.substr(lastIndex+1).trim();
    lastIndex = getNextIdxQuoted(str);
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
        lastIndex = getNextIdxQuoted(str);
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
      lastIndex = getNextIdxQuoted(str);
      part.id = str.substring(1, lastIndex);
      str = str.substr(lastIndex+1).trim();
    } else
      str = str.substr(4);

    // content description
    if (str.substr(0, 3) !== 'NIL') {
      lastIndex = getNextIdxQuoted(str);
      part.description = str.substring(1, lastIndex);
      str = str.substr(lastIndex+1).trim();
    } else
      str = str.substr(4);

    // content encoding
    if (str.substr(0, 3) !== 'NIL') {
      lastIndex = getNextIdxQuoted(str);
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
        lastIndex = getNextIdxQuoted(str);
        part.md5 = str.substring(1, lastIndex);
        str = str.substr(lastIndex+1).trim();
      } else
        str = str.substr(4);

      // [disposition]
      if (str.length > 0) {
        if (str.substr(0, 3) !== 'NIL') {
          part.disposition = { type: null, params: null };
          str = str.substr(1);
          lastIndex = getNextIdxQuoted(str);
          part.disposition.type = str.substring(1, lastIndex).toLowerCase();
          str = str.substr(lastIndex+1).trim();
          if (str[0] === '(') {
            var isKey = true, key;
            str = str.substr(1);
            part.disposition.params = {};
            while (str[0] !== ')') {
              lastIndex = getNextIdxQuoted(str);
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
                lastIndex = getNextIdxQuoted(str);
                part.language.push(str.substring(1, lastIndex));
                str = str.substr(lastIndex+1).trim();
              }
            } else {
              lastIndex = getNextIdxQuoted(str);
              part.language = [str.substring(1, lastIndex)];
              str = str.substr(lastIndex+1).trim();
            }
          } else
            str = str.substr(4);

          // [location]
          if (str.length > 0) {
            if (str.substr(0, 3) !== 'NIL') {
              lastIndex = getNextIdxQuoted(str);
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

function getNextIdxQuoted(str) {
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

function getNextIdxParen(str) {
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
  return lastIndex;
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
  if (typeof target === "boolean") {
    deep = target;
    target = arguments[1] || {};
    // skip the boolean and the target
    i = 2;
  }

  // Handle case when target is a string or something (possible in deep copy)
  if (typeof target !== "object" && !typeof target === 'function')
    target = {};

  var isPlainObject = function(obj) {
    // Must be an Object.
    // Because of IE, we also have to check the presence of the constructor property.
    // Make sure that DOM nodes and window objects don't pass through, as well
    if (!obj || toString.call(obj) !== "[object Object]" || obj.nodeType || obj.setInterval)
      return false;
    
    var has_own_constructor = hasOwnProperty.call(obj, "constructor");
    var has_is_property_of_method = hasOwnProperty.call(obj.constructor.prototype, "isPrototypeOf");
    // Not own constructor property must be Object
    if (obj.constructor && !has_own_constructor && !has_is_property_of_method)
      return false;
    
    // Own properties are enumerated firstly, so to speed up,
    // if last one is own, then all properties are own.

    var last_key;
    for (key in obj)
      last_key = key;
    
    return typeof last_key === "undefined" || hasOwnProperty.call(obj, last_key);
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
          var clone = src && (isPlainObject(src) || Array.isArray(src)) ? src : Array.isArray(copy) ? [] : {};

          // Never move original objects, clone them
          target[name] = extend(deep, clone, copy);

        // Don't bring in undefined values
        } else if (typeof copy !== "undefined")
          target[name] = copy;
      }
    }
  }

  // Return the modified object
  return target;
};

net.Stream.prototype.setSecure = function() {
  var pair = tls.createSecurePair();
  var cleartext = pipe(pair, this);

  pair.on('secure', function() {
    process.nextTick(function() { cleartext.socket.emit('secure'); });
  });

  cleartext._controlReleased = true;
  return cleartext;
};

function pipe(pair, socket) {
  pair.encrypted.pipe(socket);
  socket.pipe(pair.encrypted);

  pair.fd = socket.fd;
  var cleartext = pair.cleartext;
  cleartext.socket = socket;
  cleartext.encrypted = pair.encrypted;

  function onerror(e) {
    if (cleartext._controlReleased)
      cleartext.socket.emit('error', e);
  }

  function onclose() {
    socket.removeListener('error', onerror);
    socket.removeListener('close', onclose);
  }

  socket.on('error', onerror);
  socket.on('close', onclose);

  return cleartext;
}