var util = require('util'), net = require('net'),
    tls = require('tls'), EventEmitter = require('events').EventEmitter,
    Socket = net.Socket;
var emptyFn = function() {}, CRLF = '\r\n', debug=emptyFn,
    STATES = {
      NOCONNECT: 0,
      NOAUTH: 1,
      AUTH: 2,
      BOXSELECTING: 3,
      BOXSELECTED: 4
    }, 
    BOX_ATTRIBS = ['NOINFERIORS', 'NOSELECT', 'MARKED', 'UNMARKED'],
    BOX_STATUS_DATA_ITEMS = ['MESSAGES', 'RECENT', 'UIDNEXT', 'UIDVALIDITY', 'UNSEEN'],
    MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'],
    reFetch = /^\* (\d+) FETCH .+? \{(\d+)\}\r\n/;

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
  this._options = extend(true, this._options, options);

  if (typeof this._options.debug === 'function')
    debug = this._options.debug;
  this.delim = null;
  this.namespaces = { personal: [], other: [], shared: [] };
  this.capabilities = [];
};
util.inherits(ImapConnection, EventEmitter);
exports.ImapConnection = ImapConnection;

ImapConnection.prototype.connect = function(loginCb) {
  var self = this,
      fnInit = function() {
        // First get pre-auth capabilities, including server-supported auth
        // mechanisms
        self._send('CAPABILITY', function() {
          // Next, attempt to login
          self._login(function(err, reentry) {
            if (err) {
              loginCb(err);
              return;
            }
            // Next, get the list of available namespaces if supported
            if (!reentry && self.capabilities.indexOf('NAMESPACE') > -1) {
              var fnMe = arguments.callee;
              // Re-enter this function after we've obtained the available
              // namespaces
              self._send('NAMESPACE', function(e) { fnMe.call(this, e, true); });
              return;
            }
            // Lastly, get the top-level mailbox hierarchy delimiter used by the
            // server
            self._send(((self.capabilities.indexOf('XLIST') == -1) ? 'LIST' : 'XLIST') + ' "" ""', loginCb);
          });
        });
      };
  loginCb = loginCb || emptyFn;
  this._reset();

  this._state.conn = new Socket();
  this._state.conn.setKeepAlive(true);

  if (this._options.secure) {
    // TODO: support STARTTLS
    this._state.conn.cleartext = this._state.conn.setSecure();
    this._state.conn.on('secure', function() {
      debug.call(self._options,'Secure connection made.');
    });
    //this._state.conn.cleartext.setEncoding('utf8');
  } else {
    //this._state.conn.setEncoding('utf8');
    this._state.conn.cleartext = this._state.conn;
  }

  this._state.conn.on('connect', function() {
    clearTimeout(self._state.tmrConn);
    debug.call(self._options,'Connected to host.');
    self._state.conn.cleartext.write('');
    self._state.status = STATES.NOAUTH;
  });
  this._state.conn.on('ready', function() {
    fnInit();
  });
  this._state.conn.cleartext.on('data', function(data) {
    if (data.length === 0) return;
    var trailingCRLF = false, literalInfo;
    debug.call(self._options,'\n<<RECEIVED>>: ' + util.inspect(data.toString()) + '\n');

    if (self._state.curExpected === 0) {
      if (data.indexOf(CRLF) === -1) {
        if (self._state.curData)
          self._state.curData = bufferAppend(self._state.curData, data);
        else
          self._state.curData = data;
        return;
      }
      if (self._state.curData && self._state.curData.length) {
        data = bufferAppend(self._state.curData, data);
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
          if (curReq._msgtype === 'headers') {
            chunk.copy(self._state.curData, curReq.curPos, 0);
            curReq.curPos += chunk.length;
          }
          else
            curReq._msg.emit('data', chunk);
        }
      }
      if (curReq._done) {
        var restDesc;
        if (curReq._done === 1) {
          if (curReq._msgtype === 'headers')
            curReq._headers = self._state.curData.toString();
          self._state.curData = null;
          curReq._done = true;
        }

        if (self._state.curData)
          self._state.curData = bufferAppend(self._state.curData, data);
        else
          self._state.curData = data;

        if ((restDesc = self._state.curData.toString().match(/^(.*?)\)\r\n/))) {
          if (restDesc[1]) {
            restDesc[1] = restDesc[1].trim();
            if (restDesc[1].length)
              restDesc[1] = ' ' + restDesc[1];
          } else
            restDesc[1] = '';
          parseFetch(curReq._desc + restDesc[1], curReq._headers, curReq._msg);
          data = self._state.curData.slice(self._state.curData.indexOf(CRLF)
                                           + 2);
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
    } else if (self._state.curExpected === 0
               && (literalInfo = (strdata = data.toString()).match(reFetch))) {
      self._state.curExpected = parseInt(literalInfo[2], 10);
      var idxCRLF = data.indexOf(CRLF),
          curReq = self._state.requests[0],
          type = /BODY\[(.*)\](?:\<\d+\>)?/.exec(strdata.substring(0, idxCRLF)),
          msg = new ImapMessage(),
          desc = strdata.substring(data.indexOf('(')+1, idxCRLF).trim();
      msg.seqno = parseInt(literalInfo[1], 10);
      type = type[1];
      curReq._desc = desc;
      curReq._msg = msg;
      curReq._fetcher.emit('message', msg);
      curReq._msgtype = (type.indexOf('HEADER') === 0 ? 'headers' : 'body');
      if (curReq._msgtype === 'headers') {
        self._state.curData = new Buffer(self._state.curExpected);
        curReq.curPos = 0;
      }
      self._state.conn.cleartext.emit('data', data.slice(idxCRLF + 2));
      return;
    }

    if (data.length === 0)
      return;
    var endsInCRLF = (data[data.length-2] === 13 && data[data.length-1] === 10);
    data = data.split(CRLF);

    // Defer any extra server responses found in the incoming data
    if (data.length > 1) {
      for (var i=1,len=data.length; i<len; ++i) {
        (function(line, isLast) {
          process.nextTick(function() {
            var needsCRLF = !isLast || (isLast && endsInCRLF),
                b = new Buffer(needsCRLF ? line.length + 2 : line.length);
            line.copy(b, 0, 0);
            if (needsCRLF) {
              b[b.length-2] = 13;
              b[b.length-1] = 10;
            }
            self._state.conn.cleartext.emit('data', b);
          });
        })(data[i], i === len-1);
      }
    }

    data = data[0].toString().explode(' ', 3);

    if (data[0] === '*') { // Untagged server response
      if (self._state.status === STATES.NOAUTH) {
        if (data[1] === 'PREAUTH') { // the server pre-authenticated us
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
          self.capabilities = data[2].split(' ').map(up);
        break;
        case 'FLAGS':
          if (self._state.status === STATES.BOXSELECTING) {
            self._state.box._flags = data[2].substr(1, data[2].length-2)
                                            .split(' ').map(function(flag) {
                                              return flag.substr(1);
                                            });
          }
        break;
        case 'OK':
          if ((result = /^\[ALERT\] (.*)$/i.exec(data[2])))
            self.emit('alert', result[1]);
          else if (self._state.status === STATES.BOXSELECTING) {
            var result;
            if ((result = /^\[UIDVALIDITY (\d+)\]/i.exec(data[2])))
              self._state.box.validity = result[1];
            else if ((result = /^\[UIDNEXT (\d+)\]/i.exec(data[2])))
              self._state.box._uidnext = result[1];
            else if ((result = /^\[PERMANENTFLAGS \((.*)\)\]/i.exec(data[2]))) {
              self._state.box.permFlags = result[1].split(' ');
              var idx;
              if ((idx = self._state.box.permFlags.indexOf('\\*')) > -1) {
                self._state.box._newKeywords = true;
                self._state.box.permFlags.splice(idx, 1);
              }
              self._state.box.keywords = self._state.box.permFlags
                                             .filter(function(flag) {
                                               return (flag[0] !== '\\');
                                             });
              for (var i=0; i<self._state.box.keywords.length; i++)
                self._state.box.permFlags.splice(self._state.box.permFlags.indexOf(self._state.box.keywords[i]), 1);
              self._state.box.permFlags = self._state.box.permFlags
                                              .map(function(flag) {
                                                return flag.substr(1);
                                              });
            }
          }
        break;
        case 'NAMESPACE':
          parseNamespaces(data[2], self.namespaces);
        break;
        case 'SEARCH':
          self._state.requests[0].args.push(data[2] === undefined
                                            || data[2].length === 0
                                            ? [] : data[2].split(' '));
        break;
        case 'STATUS':
          var result = {}, foo;
          data[2].match(new RegExp('(('+ BOX_STATUS_DATA_ITEMS.join('|')+') \\d*)','gi')).forEach(function (elm) {
            foo = elm.split(' ');
            result[foo[0].toLowerCase()] = parseInt(foo[1], 10);
          });
          self._state.requests[0].args.push(result);
        break;
        case 'LIST':
        case 'XLIST':
          var result;
          if (self.delim === null
              && (result = /^\(\\No[sS]elect\) (.+?) .*$/.exec(data[2])))
            self.delim = (result[1] === 'NIL'
                          ? false : result[1].substring(1, result[1].length-1));
          else if (self.delim !== null) {
            if (self._state.requests[0].args.length === 0)
              self._state.requests[0].args.push({});
            result = /^\((.*)\) (.+?) (.+)$/.exec(data[2]);
            var box = {
              attribs: result[1].split(' ').map(function(attrib) {
                         return attrib.substr(1).toUpperCase();
                       })/*.filter(function(attrib) {
                         return (BOX_ATTRIBS.indexOf(attrib) > -1);
                       })*/,
              delim: (result[2] === 'NIL'
                      ? false : result[2].substring(1, result[2].length-1)),
              children: null,
              parent: null
            }, name = result[3].replace(/^"/,'').replace(/"$/,''), curChildren = self._state.requests[0].args[0];

            if (box.delim) {
              var path = name.split(box.delim).filter(isNotEmpty),
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
            curChildren[name] = box;
          }
        break;
        default:
          if (/^\d+$/.test(data[1])) {
            var isUnsolicited = (self._state.requests[0] &&
                      self._state.requests[0].command.indexOf('NOOP') > -1) ||
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
                  parseFetch(data[2].substring(data[2].indexOf("(")+1,
                                               data[2].lastIndexOf(")")),
                             "", msg);
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
            if ((self._state.ext.idle.state === IDLE_READY || self._state.requests[0].command == 'NOOP') && /^(EXISTS|EXPUNGE|RECENT|FETCH)/.test(data[2])) {
              // Emit 'idleResponse' event for untagged server responses received from a NOOP
              // or while idling.
              //
              // In the case on new message arriving in mailbox, both the 'mail' event 
              // (see 'EXISTS' case above) and this 'idleResponse' event will be triggered.
              //
              // In the case on flags changing on an existing message and the response
              // is not from an IDLE command, both the 'message' event (see default
              // case above) and this 'idleResponse' event will be triggered.
              
              // parse flags on FETCH response into data structure
              var rData = data[2].trim().explode(' ',2);
              if (rData[0] == 'FETCH') {
                var flags = false;
                try {
                  flags = rData[1].match(/^\(FLAGS \((.*)\)\)/).pop().split(' ');
                } catch (e) {}
              }
              
              self.emit('idleResponse', parseInt(data[1]), rData[0], flags);
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
        self._state.requests[0].callback.apply(self, args);
      }


      var recentCmd = self._state.requests[0].command;
      self._state.requests.shift();
      if (self._state.requests.length === 0
          && recentCmd !== 'LOGOUT') {
        if (self._state.status === STATES.BOXSELECTED &&
            self.capabilities.indexOf('IDLE') > -1) {
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
            } else if (self.capabilities.indexOf('IDLE') === -1)
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
  this._state.conn.on('end', function() {
    if (self._state.status === STATES.NOAUTH) {
      loginCb(new Error('Unable to authenticate.'));
    }
    self._reset();
    debug.call(self._options,'FIN packet received. Disconnecting...');
    self.emit('end');
  });
  this._state.conn.on('error', function(err) {
    clearTimeout(self._state.tmrConn);
    if (self._state.status === STATES.NOCONNECT)
      loginCb(new Error('Unable to connect. Reason: ' + err));
    debug.call(self._options,'Error occurred: ' + err);
    self.emit('error', err);
  });
  this._state.conn.on('close', function(had_error) {
    self._reset();
    debug.call(self._options,'Connection forcefully closed.');
    self.emit('close', had_error);
  });

  this._state.conn.connect(this._options.port, this._options.host);
  this._state.tmrConn = setTimeout(this._fnTmrConn.bind(this),
                                   this._options.connTimeout, loginCb);
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
    if (readOnly === undefined)
      cb = emptyFn;
    else
      cb = readOnly;
    readOnly = false;
  }
  this._state.status = STATES.BOXSELECTING;
  this._state.box.name = name;

  this._send((readOnly ? 'EXAMINE' : 'SELECT') + ' "' + escape(name) + '"', cb);
};

ImapConnection.prototype.boxStatus = function (name, dataItems, cb) {
  if (this._state.status < STATES.AUTH) {
    throw new Error('Not connected or authenticated');
  }
  if (typeof cb !== 'function') {
    if (typeof dataItems === 'function') {
      cb = dataItems;
      dataItems = BOX_STATUS_DATA_ITEMS;
    } else {
      // doing a STATUS call without having a callback
      // to do something with the results has no purpose
      return false;
    }
  }
  // filter out invalid data items for STATUS calls
  // see: http://tools.ietf.org/html/rfc3501#section-6.3.10
  dataItems = dataItems.filter(function(elm, idx) {
    return (BOX_STATUS_DATA_ITEMS.indexOf(elm) > -1);
  });

  this._send('STATUS "' + escape(name) + '" ('+ dataItems.join(' ') +')', cb);
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
  this._send(((this.capabilities.indexOf('XLIST') == -1) ? 'LIST' : 'XLIST') + ' "' + escape(namespace) + '" "*"', cb);
};

ImapConnection.prototype.addBox = function(name, cb) {
  cb = arguments[arguments.length-1];
  if (typeof name !== 'string' || name.length === 0)
    throw new Error('Mailbox name must be a string describing the full path'
                    + ' of a new mailbox to be created');
  this._send('CREATE "' + escape(name) + '"', cb);
};

ImapConnection.prototype.delBox = function(name, cb) {
  cb = arguments[arguments.length-1];
  if (typeof name !== 'string' || name.length === 0)
    throw new Error('Mailbox name must be a string describing the full path'
                    + ' of an existing mailbox to be deleted');
  this._send('DELETE "' + escape(name) + '"', cb);
};

ImapConnection.prototype.renameBox = function(oldname, newname, cb) {
  cb = arguments[arguments.length-1];
  if (typeof oldname !== 'string' || oldname.length === 0)
    throw new Error('Old mailbox name must be a string describing the full path'
                    + ' of an existing mailbox to be renamed');
  else if (typeof newname !== 'string' || newname.length === 0)
    throw new Error('New mailbox name must be a string describing the full path'
                    + ' of a new mailbox to be renamed to');
  if (this._state.status === STATES.BOXSELECTED
      && oldname === this._state.box.name && oldname !== 'INBOX')
    this._state.box._newName = oldname;
    
  this._send('RENAME "' + escape(oldname) + '" "' + escape(newname) + '"', cb);
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
             + buildSearchQuery(options, this.capabilities), cb);
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
  cmd = 'APPEND "'+escape(options.mailbox)+'"';
  if ('flags' in options) {
    if (!Array.isArray(options.flags))
      options.flags = Array(options.flags);
    cmd += " (\\"+options.flags.join(' \\')+")";
  }
  if ('date' in options) {
    if (!(options.date instanceof Date))
      throw new Error('Expected null or Date object for date');
    cmd += ' "'+options.date.getDate()+'-'+MONTHS[options.date.getMonth()]+'-'+options.date.getFullYear();
    cmd += ' '+('0'+options.date.getHours()).slice(-2)+':'+('0'+options.date.getMinutes()).slice(-2)+':'+('0'+options.date.getSeconds()).slice(-2);
    cmd += ((options.date.getTimezoneOffset() > 0) ? ' -' : ' +' );
    cmd += ('0'+(-options.date.getTimezoneOffset() / 60)).slice(-2);
    cmd += ('0'+(-options.date.getTimezoneOffset() % 60)).slice(-2);
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
    debug.call(self._options,'\n<<SENT>>: ' + util.inspect(data.toString()) + '\n');
  });
}

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
  validateUIDList(uids);

  var opts = {
    markSeen: false,
    request: {
      struct: true,
      headers: true, // \_______ at most one of these can be used for any given
                    //   _______ fetch request
      body: false  //   /
    }
  }, toFetch, bodyRange = '', self = this;
  if (typeof options !== 'object')
    options = {};
  extend(true, opts, options);

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
    if (typeof opts.request.headers === 'boolean'
        && opts.request.headers === true) {
      // fetches headers only
      toFetch = 'HEADER';
    } else if (typeof opts.request.body === 'boolean'
               && opts.request.body === true) {
      // fetches the whole entire message text (minus the headers), including
      // all message parts
      toFetch = 'TEXT';
    } else if (typeof opts.request.body === 'string') {
      if (opts.request.body.toUpperCase() === 'FULL') {
        // fetches the whole entire message (including the headers)
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
  }

  var extensions = '';
  if (this.capabilities.indexOf('X-GM-EXT-1') > -1)
    extensions = 'X-GM-THRID X-GM-MSGID X-GM-LABELS ';

  this._send(which + 'FETCH ' + uids.join(',') + ' (' + extensions
             + 'UID FLAGS INTERNALDATE'
             + (opts.request.struct ? ' BODYSTRUCTURE' : '')
             + (typeof toFetch === 'string' ? ' BODY'
             + (!opts.markSeen ? '.PEEK' : '')
             + '[' + toFetch + ']' + bodyRange : '') + ')', function(e) {
               var fetcher = self._state.requests[0]._fetcher;
               if (e && fetcher)
                 fetcher.emit('error', e);
               else if (e && !fetcher)
                 self.emit('error', e);
               else if (fetcher)
                 fetcher.emit('end');
             }
  );
  var imapFetcher = new ImapFetch();
  this._state.requests[this._state.requests.length-1]._fetcher = imapFetcher;
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

  validateUIDList(uids);

  this._send(which + 'COPY ' + uids.join(',') + ' "' + escape(boxTo) + '"', cb);
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
          self.delFlags(deletedUIDs[counter], 'DELETED', function(e) {
            process.nextTick(function() {
              fnMe.call(this, e, reentryCount, deletedUIDs, counter+1);
            });
          });
        } else
          fnMe.call(this, err, reentryCount+1, deletedUIDs);
      } else if (reentryCount === 2) {
        self.addFlags(uids, 'Deleted', function(e) {
          fnMe.call(this, e, reentryCount+1, deletedUIDs);
        });
      } else if (reentryCount === 3) {
        self.removeDeleted(function(e) {
          fnMe.call(this, e, reentryCount+1, deletedUIDs);
        });
      } else if (reentryCount === 4) {
        if (counter < deletedUIDs.length) {
          self.addFlags(deletedUIDs[counter], 'DELETED', function(e) {
            process.nextTick(function() {
              fnMe.call(this, e, reentryCount, deletedUIDs, counter+1);
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
}

ImapConnection.prototype._store = function(which, uids, flags, isAdding, cb) {
  var isKeywords = (arguments.callee.caller === this.addKeywords
                    || arguments.callee.caller === this.delKeywords);
  if (this._state.status !== STATES.BOXSELECTED)
    throw new Error('No mailbox is currently selected');
  if (uids === undefined)
    throw new Error('The message ID(s) must be specified');

  if (!Array.isArray(uids))
    uids = [uids];
  validateUIDList(uids);

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
    if (this.capabilities.indexOf('LOGINDISABLED') > -1) {
      cb(new Error('Logging in is disabled on this server'));
      return;
    }
    if (this.capabilities.indexOf('AUTH=XOAUTH') >= 0 && 'xoauth' in this._options) {
      this._send('AUTHENTICATE XOAUTH ' + escape(this._options.xoauth), fnReturn);
    } else {
      this._send('LOGIN "' + escape(this._options.username) + '" "'
                 + escape(this._options.password) + '"', fnReturn);
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
  this._state.box.validity = 0;
  this._state.box._flags = [];
  this._state.box._newKeywords = false;
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
    debug.call(this._options,'\n<<SENT>>: ' + prefix + cmd + '\n');
  }
};

function ImapMessage() {}
util.inherits(ImapMessage, EventEmitter);
function ImapFetch() {}
util.inherits(ImapFetch, EventEmitter);

/****** Utility Functions ******/

function buildSearchQuery(options, extensions, isOrChild) {
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
      searchargs += ' OR (' + buildSearchQuery(args[0], extensions, true) + ') ('
                    + buildSearchQuery(args[1], extensions, true) + ')'
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
          searchargs += modifier + criteria + ' "' + escape(''+args[0]) + '"';
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
                        + MONTHS[args[0].getMonth()] + '-'
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
          var num = parseInt(args[0]);
          if (isNaN(num))
            throw new Error('Search option argument must be a number');
          searchargs += modifier + criteria + ' ' + args[0];
        break;
        case 'HEADER':
          if (!args || args.length !== 2)
            throw new Error('Incorrect number of arguments for search option: '
                            + criteria);
          searchargs += modifier + criteria + ' "' + escape(''+args[0]) + '" "'
                        + escape(''+args[1]) + '"';
        break;
        case 'UID':
          if (!args)
            throw new Error('Incorrect number of arguments for search option: '
                            + criteria);
          validateUIDList(args);
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
          searchargs += modifier + criteria + ' "' + escape(''+args[0]) + '"';
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
    if (isNaN(intval)) {
      throw new Error('Message ID/number must be an integer, "*", or a range: '
                      + uids[i]);
    } else if (typeof uids[i] !== 'number')
      uids[i] = intval;
  }
}

function parseNamespaces(str, namespaces) {
  var result = parseExpr(str);
  for (var grp=0; grp<3; ++grp) {
    if (Array.isArray(result[grp])) {
      var vals = [];
      for (var i=0,len=result[grp].length; i<len; ++i) {
        var val = { prefix: result[grp][i][0], delim: result[grp][i][1] };
        if (result[grp][i].length > 2) {
          // extension data
          val.extensions = [];
          for (var j=2,len2=result[grp][i].length; j<len2; j+=2) {
            val.extensions.push({
              name: result[grp][i][j],
              flags: result[grp][i][j+1]
            });
          }
        }
        vals.push(val);
      }
      if (grp === 0)
        namespaces.personal = vals;
      else if (grp === 1)
        namespaces.other = vals;
      else if (grp === 2)
        namespaces.shared = vals;
    }
  }
}

function parseFetch(str, literalData, fetchData) {
  var key, idxNext, result = parseExpr(str);
  for (var i=0,len=result.length; i<len; i+=2) {
    if (result[i] === 'UID')
      fetchData.id = parseInt(result[i+1], 10);
    else if (result[i] === 'INTERNALDATE')
      fetchData.date = result[i+1];
    else if (result[i] === 'FLAGS')
      fetchData.flags = result[i+1].filter(isNotEmpty);
    else if (result[i] === 'BODYSTRUCTURE')
      fetchData.structure = parseBodyStructure(result[i+1]);
    else if (typeof result[i] === 'string') // simple extensions
      fetchData[result[i].toLowerCase()] = result[i+1];
    else if (Array.isArray(result[i]) && typeof result[i][0] === 'string' &&
             result[i][0].indexOf('HEADER') === 0 && literalData) {
      var headers = literalData.split(/\r\n(?=[\w])/), header;
      fetchData.headers = {};
      for (var j=0,len2=headers.length; j<len2; ++j) {
        header = headers[j].substring(0, headers[j].indexOf(': ')).toLowerCase();
        if (!fetchData.headers[header])
          fetchData.headers[header] = [];
        fetchData.headers[header].push(headers[j].substr(headers[j]
                                                 .indexOf(': ')+2)
                                                 .replace(/\r\n/g, '').trim());
      }
    }
  }
}

function parseBodyStructure(cur, prefix, partID) {
  var ret = [];
  if (prefix === undefined) {
    var result = (Array.isArray(cur) ? cur : parseExpr(cur));
    if (result.length)
      ret = parseBodyStructure(result, '', 1);
  } else {
    var part, partLen = cur.length, next;
    if (Array.isArray(cur[0])) { // multipart
      next = -1;
      while (Array.isArray(cur[++next])) {
        ret.push(parseBodyStructure(cur[next], prefix
                                               + (prefix !== '' ? '.' : '')
                                               + (partID++).toString(), 1));
      }
      part = { type: cur[next++].toLowerCase() };
      if (partLen > next) {
        if (Array.isArray(cur[next])) {
          part.params = {};
          for (var i=0,len=cur[next].length; i<len; i+=2)
            part.params[cur[next][i].toLowerCase()] = cur[next][i+1];
        } else
          part.params = cur[next];
        ++next;
      }
    } else { // single part
      next = 7;
      if (typeof cur[1] === 'string') {
        part = {
          // the path identifier for this part, useful for fetching specific
          // parts of a message
          partID: (prefix !== '' ? prefix : '1'),

          // required fields as per RFC 3501 -- null or otherwise
          type: cur[0].toLowerCase(), subtype: cur[1].toLowerCase(),
          params: null, id: cur[3], description: cur[4], encoding: cur[5],
          size: cur[6]
        }
      } else {
        // type information for malformed multipart body
        part = { type: cur[0].toLowerCase(), params: null };
        cur.splice(1, 0, null);
        ++partLen;
        next = 2;
      }
      if (Array.isArray(cur[2])) {
        part.params = {};
        for (var i=0,len=cur[2].length; i<len; i+=2)
          part.params[cur[2][i].toLowerCase()] = cur[2][i+1];
        if (cur[1] === null)
          ++next;
      }
      if (part.type === 'message' && part.subtype === 'rfc822') {
        // envelope
        if (partLen > next && Array.isArray(cur[next])) {
          part.envelope = {};
          for (var i=0,field,len=cur[next].length; i<len; ++i) {
            if (i === 0)
              part.envelope.date = cur[next][i];
            else if (i === 1)
              part.envelope.subject = cur[next][i];
            else if (i >= 2 && i <= 7) {
              var val = cur[next][i];
              if (Array.isArray(val)) {
                var addresses = [], inGroup = false, curGroup;
                for (var j=0,len2=val.length; j<len2; ++j) {
                  if (val[j][3] === null) { // start group addresses
                    inGroup = true;
                    curGroup = {
                      group: val[j][2],
                      addresses: []
                    };
                  } else if (val[j][2] === null) { // end of group addresses
                    inGroup = false;
                    addresses.push(curGroup);
                  } else { // regular user address
                    var info = {
                      name: val[j][0],
                      mailbox: val[j][2],
                      host: val[j][3]
                    };
                    if (inGroup)
                      curGroup.addresses.push(info);
                    else
                      addresses.push(info);
                  }
                }
                val = addresses;
              }
              if (i === 2)
                part.envelope.from = val;
              else if (i === 3)
                part.envelope.sender = val;
              else if (i === 4)
                part.envelope['reply-to'] = val;
              else if (i === 5)
                part.envelope.to = val;
              else if (i === 6)
                part.envelope.cc = val;
              else if (i === 7)
                part.envelope.bcc = val;
            } else if (i === 8)
              // message ID being replied to
              part.envelope['in-reply-to'] = cur[next][i];
            else if (i === 9)
              part.envelope['message-id'] = cur[next][i];
            else
              break;
          }
        } else
          part.envelope = null;
        ++next;

        // body
        if (partLen > next && Array.isArray(cur[next])) {
          part.body = parseBodyStructure(cur[next], prefix
                                                    + (prefix !== '' ? '.' : '')
                                                    + (partID++).toString(), 1);
        } else
          part.body = null;
        ++next;
      }
      if ((part.type === 'text'
           || (part.type === 'message' && part.subtype === 'rfc822'))
          && partLen > next)
        part.lines = cur[next++];
      if (typeof cur[1] === 'string' && partLen > next)
        part.md5 = cur[next++];
    }
    // add any extra fields that may or may not be omitted entirely
    parseStructExtra(part, partLen, cur, next);
    ret.unshift(part);
  }
  return ret;
}

function parseStructExtra(part, partLen, cur, next) {
  if (partLen > next) {
    // disposition
    // null or a special k/v list with these kinds of values:
    // e.g.: ['Foo', null]
    //       ['Foo', ['Bar', 'Baz']]
    //       ['Foo', ['Bar', 'Baz', 'Bam', 'Pow']]
    if (Array.isArray(cur[next])) {
      part.disposition = {};
      if (Array.isArray(cur[next][1])) {
        for (var i=0,len=cur[next][1].length; i<len; i+=2)
          part.disposition[cur[next][1][i].toLowerCase()] = cur[next][1][i+1];
      } else
        part.disposition[cur[next][0]] = cur[next][1];
    } else
      part.disposition = cur[next];
    ++next;
  }
  if (partLen > next) {
    // language can be a string or a list of one or more strings, so let's
    // make this more consistent ...
    if (cur[next] !== null)
      part.language = (Array.isArray(cur[next]) ? cur[next] : [cur[next]]);
    else
      part.language = null;
    ++next;
  }
  if (partLen > next)
    part.location = cur[next++];
  if (partLen > next) {
    // extension stuff introduced by later RFCs
    // this can really be any value: a string, number, or (un)nested list
    // let's not parse it for now ...
    part.extensions = cur[next];
  }
}

String.prototype.explode = function(delimiter, limit) {
  if (arguments.length < 2 || arguments[0] === undefined
      || arguments[1] === undefined
      || !delimiter || delimiter === '' || typeof delimiter === 'function'
      || typeof delimiter === 'object')
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
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function unescape(str) {
  return str.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function up(str) {
  return str.toUpperCase();
}

function parseExpr(o, result, start) {
  start = start || 0;
  var inQuote = false, lastPos = start - 1, isTop = false;
  if (!result)
    result = new Array();
  if (typeof o === 'string') {
    var state = new Object();
    state.str = o;
    o = state;
    isTop = true;
  }
  for (var i=start,len=o.str.length; i<len; ++i) {
    if (!inQuote) {
      if (o.str[i] === '"')
        inQuote = true;
      else if (o.str[i] === ' ' || o.str[i] === ')' || o.str[i] === ']') {
        if (i - (lastPos+1) > 0)
          result.push(convStr(o.str.substring(lastPos+1, i)));
        if (o.str[i] === ')' || o.str[i] === ']')
          return i;
        lastPos = i;
      } else if (o.str[i] === '(' || o.str[i] === '[') {
        var innerResult = [];
        i = parseExpr(o, innerResult, i+1);
        lastPos = i;
        result.push(innerResult);
      }
    } else if (o.str[i] === '"' &&
               (o.str[i-1] &&
                (o.str[i-1] !== '\\' || (o.str[i-2] && o.str[i-2] === '\\'))))
      inQuote = false;
    if (i+1 === len && len - (lastPos+1) > 0)
      result.push(convStr(o.str.substring(lastPos+1)));
  }
  return (isTop ? result : start);
}

function convStr(str) {
  if (str[0] === '"')
    return str.substring(1, str.length-1);
  else if (str === 'NIL')
    return null;
  else if (/^\d+$/.test(str)) {
    // some IMAP extensions utilize large (64-bit) integers, which JavaScript
    // can't handle natively, so we'll just keep it as a string if it's too big
    var val = parseInt(str, 10);
    return (val.toString() === str ? val : str);
  } else
    return str;
}

/**
 * Adopted from jquery's extend method. Under the terms of MIT License.
 *
 * http://code.jquery.com/jquery-1.4.2.js
 *
 * Modified by Brian White to use Array.isArray instead of the custom isArray
 * method
 */
function extend() {
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
  if (typeof target !== "object" && !typeof target === 'function')
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
          target[name] = extend(deep, clone, copy);

        // Don't bring in undefined values
        } else if (copy !== undefined)
          target[name] = copy;
      }
    }
  }

  // Return the modified object
  return target;
};

function bufferAppend(buf1, buf2) {
  var newBuf = new Buffer(buf1.length + buf2.length);
  buf1.copy(newBuf, 0, 0);
  if (Buffer.isBuffer(buf2))
    buf2.copy(newBuf, buf1.length, 0);
  else if (Array.isArray(buf2)) {
    for (var i=buf1.length, len=buf2.length; i<len; i++)
      newBuf[i] = buf2[i];
  }

  return newBuf;
};

Buffer.prototype.split = function(str) {
  if ((typeof str !== 'string' && !Array.isArray(str))
      || str.length === 0 || str.length > this.length)
    return [this];
  var search = !Array.isArray(str)
                ? str.split('').map(function(el) { return el.charCodeAt(0); })
                : str,
      searchLen = search.length,
      ret = [], pos, start = 0;

  while ((pos = this.indexOf(search, start)) > -1) {
    ret.push(this.slice(start, pos));
    start = pos + searchLen;
  }
  if (!ret.length)
    ret = [this];
  else if (start < this.length)
    ret.push(this.slice(start));
  
  return ret;
};

Buffer.prototype.indexOf = function(str, start) {
  if (str.length > this.length)
    return -1;
  var search = !Array.isArray(str)
                ? str.split('').map(function(el) { return el.charCodeAt(0); })
                : str,
      searchLen = search.length,
      ret = -1, i, j, len;
  for (i=start||0,len=this.length; i<len; ++i) {
    if (this[i] == search[0] && (len-i) >= searchLen) {
      if (searchLen > 1) {
        for (j=1; j<searchLen; ++j) {
          if (this[i+j] != search[j])
            break;
          else if (j == searchLen-1) {
            ret = i;
            break;
          }
        }
      } else
        ret = i;
      if (ret > -1)
        break;
    }
  }
  return ret;
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
