var tls = require('tls'),
    Socket = require('net').Socket,
    EventEmitter = require('events').EventEmitter,
    inherits = require('util').inherits,
    inspect = require('util').inspect,
    isDate = require('util').isDate,
    utf7 = require('utf7').imap;

var Parser = require('./Parser').Parser;

var MAX_INT = 9007199254740992,
    KEEPALIVE_INTERVAL = 10000,
    MAX_IDLE_WAIT = 300000, // 5 minutes
    MONTHS = ['Jan', 'Feb', 'Mar',
              'Apr', 'May', 'Jun',
              'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'],
    FETCH_ATTR_MAP = {
      'RFC822.SIZE': 'size',
      'BODY': 'struct',
      'BODYSTRUCTURE': 'struct',
      'UID': 'uid',
      'INTERNALDATE': 'date',
      'FLAGS': 'flags',
      'X-GM-THRID': 'x-gm-thrid',
      'X-GM-MSGID': 'x-gm-msgid',
      'X-GM-LABELS': 'x-gm-labels'
    },
    CRLF = '\r\n',
    RE_CMD = /^([^ ]+)(?: |$)/,
    RE_UIDCMD_HASRESULTS = /^UID (?:FETCH|SEARCH|SORT)/,
    RE_IDLENOOPRES = /^(IDLE|NOOP) /,
    RE_OPENBOX = /^EXAMINE|SELECT$/,
    RE_BODYPART = /^BODY\[/,
    RE_INVALID_KW_CHARS = /[\(\)\{\\\"\]\%\*\x00-\x20\x7F]/,
    RE_NUM_RANGE = /^(?:[\d]+|\*):(?:[\d]+|\*)$/,
    RE_BACKSLASH = /\\/g,
    RE_BACKSLASH_ESC = /\\\\/g,
    RE_DBLQUOTE = /"/g,
    RE_DBLQUOTE_ESC = /\\"/g,
    RE_INTEGER = /^\d+$/;

function Connection(config) {
  if (!(this instanceof Connection))
    return new Connection(config);

  EventEmitter.call(this);

  config || (config = {});

  this._config = {
    host: config.host || 'localhost',
    port: config.port || 143,
    secure: (config.secure === true ? 'implicit' : config.secure),
    secureOptions: config.secureOptions,
    user: config.user,
    password: config.password,
    connTimeout: config.connTimeout || 10000,
    keepalive: (typeof config.keepalive === 'boolean'
                ? config.keepalive
                : true)
  };

  this._sock = undefined;
  this._tagcount = 0;
  this._tmrConn = undefined;
  this._queue = [];
  this._box = undefined;
  this._idle = {};
  this.delimiter = undefined;
  this.namespaces = undefined;
  this.state = 'disconnected';
  this.debug = config.debug;
}
inherits(Connection, EventEmitter);

Connection.prototype.connect = function() {
  var config = this._config, self = this, socket, tlsSocket, parser, tlsOptions;

  socket = new Socket();
  socket.setKeepAlive(true);
  socket.setTimeout(0);
  this._state = 'disconnected';

  if (config.secure) {
    tlsOptions = {};
    for (var k in config.secureOptions)
      tlsOptions[k] = config.secureOptions[k];
    tlsOptions.socket = socket;
  }

  if (config.secure === 'implicit')
    this._sock = tlsSocket = tls.connect(tlsOptions, onconnect);
  else {
    socket.once('connect', onconnect);
    this._sock = socket;
  }

  function onconnect() {
    clearTimeout(self._tmrConn);
    self.state = 'connected';
    self.debug&&self.debug('[connection] Connected to host');
  }

  this._sock.once('error', function(err) {
    clearTimeout(self._tmrConn);
    clearTimeout(self._tmrKeepalive);
    self.debug&&self.debug('[connection] Error: ' + err);
    err.source = 'socket';
    self.emit('error', err);
  });

  socket.once('close', function(had_err) {
    clearTimeout(self._tmrConn);
    clearTimeout(self._tmrKeepalive);
    self.debug&&self.debug('[connection] Closed');
    self.emit('close', had_err);
  });

  socket.once('end', function() {
    clearTimeout(self._tmrConn);
    clearTimeout(self._tmrKeepalive);
    self.debug&&self.debug('[connection] Ended');
    self.emit('end');
  });

  parser = new Parser(this._sock, this.debug);

  parser.on('untagged', function(info) {
    self._resUntagged(info);
  });
  parser.on('tagged', function(info) {
    self._resTagged(info);
  });
  parser.on('body', function(stream, info) {
    var msg = self._curReq.fetchCache[info.seqno], toget;

    if (msg === undefined) {
      msg = self._curReq.fetchCache[info.seqno] = {
        msgEmitter: new EventEmitter(),
        toget: self._curReq.fetching.slice(0),
        attrs: {},
        ended: false
      };

      self._curReq.bodyEmitter.emit('message', msg.msgEmitter, info.seqno);
    }

    toget = msg.toget;

    var idx = toget.indexOf('BODY[' + info.which + ']');
    if (idx > -1) {
      toget.splice(idx, 1);
      msg.msgEmitter.emit('body', stream, info);
    } else
      stream.resume(); // a body we didn't ask for?
  });
  parser.on('continue', function(info) {
    // only needed for IDLE and APPEND
    var type = self._curReq.type;
    if (type === 'IDLE') {
      // now idling
      self._idle.started = Date.now();
    } else if (/^AUTHENTICATE XOAUTH/.test(self._curReq.fullcmd)) {
      self._curReq.oauthError = new Buffer(info.text, 'base64').toString('utf8');
      self._sock.write(CRLF);
    } else if (type === 'APPEND')
      self._sock.write(self._curReq.appendData);
  });
  parser.on('other', function(line) {
    var m;
    if (m = RE_IDLENOOPRES.exec(line)) {
      if (m[1] === 'IDLE') {
        // no longer idling
        self._idle.enabled = false;
        self._idle.started = undefined;
      }

      self._curReq = undefined;

      if (self._queue.length === 0
          && self._config.keepalive
          && self.state === 'authenticated') {
        self._idle.enabled = true;
        self._doKeepaliveTimer(true);
      }

      self._processQueue();
    }
  });

  this._tmrConn = setTimeout(function() {
    var err = new Error('Connection timed out');
    err.source = 'timeout';
    self.emit('error', err);
    socket.destroy();
  }, config.connTimeout);

  socket.connect(config.port, config.host);
};

Connection.prototype.serverSupports = function(cap) {
  return (this._caps && this._caps.indexOf(cap) > -1);
};

Connection.prototype.end = function() {
  this._sock.end();
};

Connection.prototype.append = function(data, options, cb) {
  if (typeof options === 'function') {
    cb = options;
    options = undefined;
  }
  options = options || {};
  if (!options.mailbox) {
    if (!this._box)
      throw new Error('No mailbox specified or currently selected');
    else
      options.mailbox = this._box.name;
  }
  var cmd = 'APPEND "' + escape(utf7.encode(''+options.mailbox)) + '"';
  if (options.flags) {
    if (!Array.isArray(options.flags))
      options.flags = [options.flags];
    if (options.flags.length > 0)
      cmd += ' (\\' + options.flags.join(' \\') + ')';
  }
  if (options.date) {
    if (!isDate(options.date))
      throw new Error('`date` is not a Date object');
    cmd += ' "';
    cmd += options.date.getDate();
    cmd += '-';
    cmd += MONTHS[options.date.getMonth()];
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

  this._enqueue(cmd, cb);
  this._queue[this._queue.length - 1].appendData = data;
};

Connection.prototype.getBoxes = function(namespace, cb) {
  if (typeof namespace === 'function') {
    cb = namespace;
    namespace = '';
  }

  namespace = escape(utf7.encode(''+namespace));

  this._enqueue('LIST "' + namespace + '" "*"', cb);
};

Connection.prototype.openBox = function(name, readOnly, cb) {
  if (this.state !== 'authenticated')
    throw new Error('Not authenticated');

  if (cb === undefined) {
    cb = readOnly;
    readOnly = false;
  }

  name = ''+name;
  var encname = escape(utf7.encode(name)),
      cmd = (readOnly ? 'EXAMINE' : 'SELECT'),
      self = this;

  this._enqueue(cmd + ' "' + encname + '"', function(err) {
    if (err) {
      self._box = undefined;
      cb(err);
    } else {
      self._box.name = name;
      cb(err, self._box);
    }
  });
};

// also deletes any messages in this box marked with \Deleted
Connection.prototype.closeBox = function(cb) {
  var self = this;
  if (this._box === undefined)
    throw new Error('No mailbox is currently selected');

  this._enqueue('CLOSE', function(err) {
    if (!err)
      self._box = undefined;

    cb(err);
  });
};

Connection.prototype.addBox = function(name, cb) {
  this._enqueue('CREATE "' + escape(utf7.encode(''+name)) + '"', cb);
};

Connection.prototype.delBox = function(name, cb) {
  this._enqueue('DELETE "' + escape(utf7.encode(''+name)) + '"', cb);
};

Connection.prototype.renameBox = function(oldname, newname, cb) {
  var destname = newname;
  if (this._box
      && oldname === this._box.name
      && oldname.toUpperCase() !== 'INBOX')
    destname = ''+oldname;

  var encoldname = escape(utf7.encode(''+oldname)),
      encnewname = escape(utf7.encode(''+newname)),
      self = this;

  this._enqueue('RENAME "' + encoldname + '" "' + encnewname + '"',
    function(err) {
      if (err)
        return cb(err);
      self._box.name = destname;
      cb(err, self._box);
    }
  );
};

Connection.prototype.status = function(boxName, cb) {
  if (this._box && this._box.name === boxName)
    throw new Error('Cannot call status on currently selected mailbox');

  boxName = escape(utf7.encode(''+boxName));

  this._enqueue('STATUS "' + boxName + '" (MESSAGES RECENT UNSEEN UIDVALIDITY)',
                cb);
};

Connection.prototype.removeDeleted = function(uids, cb) {
  if (typeof uids === 'function') {
    cb = uids;
    uids = undefined;
  }

  if (uids !== undefined) {
    if (!Array.isArray(uids))
      uids = [uids];

    validateUIDList(uids);
    uids = uids.join(',');

    this._enqueue('UID EXPUNGE ' + uids, cb);
  } else
    this._enqueue('EXPUNGE', cb);
};

Connection.prototype.search = function(options, cb) {
  this._search('UID ', options, cb);
};

Connection.prototype._search = function(which, options, cb) {
  if (this._box === undefined)
    throw new Error('No mailbox is currently selected');
  else if (!Array.isArray(options))
    throw new Error('Expected array for search options');

  this._enqueue(which + 'SEARCH' + buildSearchQuery(options, this._caps), cb);
};

Connection.prototype.sort = function(sorts, options, cb) {
  this._sort('UID ', sorts, options, cb);
};

Connection.prototype._sort = function(which, sorts, options, cb) {
  if (this._box === undefined)
    throw new Error('No mailbox is currently selected');
  else if (!Array.isArray(sorts) || !sorts.length)
    throw new Error('Expected array with at least one sort criteria');
  else if (!Array.isArray(options))
    throw new Error('Expected array for search options');
  else if (!this.serverSupports('SORT'))
    throw new Error('Sort is not supported on the server');

  var criteria = sorts.map(function(c) {
    if (typeof c !== 'string')
      throw new Error('Unexpected sort criteria data type. '
                      + 'Expected string. Got: ' + typeof criteria);

    var modifier = '';
    if (c[0] === '-') {
      modifier = 'REVERSE ';
      c = c.substring(1);
    }
    switch (c.toUpperCase()) {
      case 'ARRIVAL':
      case 'CC':
      case 'DATE':
      case 'FROM':
      case 'SIZE':
      case 'SUBJECT':
      case 'TO':
        break;
      default:
        throw new Error('Unexpected sort criteria: ' + c);
    }

    return modifier + c;
  });

  this._enqueue(which + 'SORT (' + criteria.join(' ') + ') UTF-8'
                + buildSearchQuery(options, this._caps), cb);
};

Connection.prototype.addFlags = function(uids, flags, cb) {
  this._store('UID ', uids, flags, true, cb);
};

Connection.prototype.delFlags = function(uids, flags, cb) {
  this._store('UID ', uids, flags, false, cb);
};

Connection.prototype.addKeywords = function(uids, flags, cb) {
  this._addKeywords('UID ', uids, flags, cb);
};

Connection.prototype._addKeywords = function(which, uids, flags, cb) {
  if (this._box && !this._box.newKeywords)
    throw new Error('This mailbox does not allow new keywords to be added');
  this._store(which, uids, flags, true, cb);
};

Connection.prototype.delKeywords = function(uids, flags, cb) {
  this._store('UID ', uids, flags, false, cb);
};

Connection.prototype._store = function(which, uids, flags, isAdding, cb) {
  var isKeywords = (arguments.callee.caller === this._addKeywords
                    || arguments.callee.caller === this.delKeywords);
  if (this._box === undefined)
    throw new Error('No mailbox is currently selected');
  else if (uids === undefined)
    throw new Error('No messages specified');

  if (!Array.isArray(uids))
    uids = [uids];
  validateUIDList(uids);

  if ((!Array.isArray(flags) && typeof flags !== 'string')
      || (Array.isArray(flags) && flags.length === 0))
    throw new Error((isKeywords ? 'Keywords' : 'Flags')
                    + ' argument must be a string or a non-empty Array');
  if (!Array.isArray(flags))
    flags = [flags];
  for (var i = 0, len = flags.length; i < len; ++i) {
    if (!isKeywords) {
      if (flags[i][0] === '\\')
        flags[i] = flags[i].substr(1);
      if (this._state.box.permFlags.indexOf(flags[i].toLowerCase()) === -1
          || flags[i] === '*')
        throw new Error('The flag "' + flags[i]
                        + '" is not allowed by the server for this mailbox');
      flags[i] = '\\' + flags[i];
    } else {
      // keyword contains any char except control characters (%x00-1F and %x7F)
      // and: '(', ')', '{', ' ', '%', '*', '\', '"', ']'
      if (RE_INVALID_KW_CHARS.test(flags[i])) {
        throw new Error('The keyword "' + flags[i]
                        + '" contains invalid characters');
      }
    }
  }

  flags = flags.join(' ');
  uids = uids.join(',');
  

  this._enqueue(which + 'STORE ' + uids + ' ' + (isAdding ? '+' : '-')
                + 'FLAGS.SILENT (' + flags + ')', cb);
};

Connection.prototype.setLabels = function(uids, labels, cb) {
  this._storeLabels('UID ', uids, labels, '', cb);
};

Connection.prototype.addLabels = function(uids, labels, cb) {
  this._storeLabels('UID ', uids, labels, '+', cb);
};

Connection.prototype.delLabels = function(uids, labels, cb) {
  this._storeLabels('UID ', uids, labels, '-', cb);
};

Connection.prototype._storeLabels = function(which, uids, labels, mode, cb) {
  if (!this.serverSupports('X-GM-EXT-1'))
    throw new Error('Server must support X-GM-EXT-1 capability');
  else if (this._box === undefined)
    throw new Error('No mailbox is currently selected');
  else if (uids === undefined)
    throw new Error('No messages specified');

  if (!Array.isArray(uids))
    uids = [uids];
  validateUIDList(uids);

  if ((!Array.isArray(labels) && typeof labels !== 'string')
      || (Array.isArray(labels) && labels.length === 0))
    throw new Error('labels argument must be a string or a non-empty Array');

  if (!Array.isArray(labels))
    labels = [labels];
  labels = labels.map(function(v) {
    return '"' + escape(utf7.encode(''+v)) + '"';
  }).join(' ');

  uids = uids.join(',');

  this._enqueue(which + 'STORE ' + uids + ' ' + mode
                + 'X-GM-LABELS.SILENT (' + labels + ')', cb);
};

Connection.prototype.copy = function(uids, boxTo, cb) {
  this._copy('UID ', uids, boxTo, cb);
};

Connection.prototype._copy = function(which, uids, boxTo, cb) {
  if (this._box === undefined)
    throw new Error('No mailbox is currently selected');

  if (!Array.isArray(uids))
    uids = [uids];

  validateUIDList(uids);
  boxTo = escape(utf7.encode(''+boxTo));

  this._enqueue(which + 'COPY ' + uids.join(',') + ' "'
             + boxTo + '"', cb);
};

Connection.prototype.move = function(uids, boxTo, cb) {
  this._move('UID ', uids, boxTo, cb);
};

Connection.prototype._move = function(which, uids, boxTo, cb) {
  if (this._box === undefined)
    throw new Error('No mailbox is currently selected');

  if (this.serverSupports('MOVE')) {
    if (!Array.isArray(uids))
      uids = [uids];

    validateUIDList(uids);
    uids = uids.join(',');
    boxTo = escape(utf7.encode(''+boxTo));

    this._enqueue(which + 'MOVE ' + uids + ' "' + boxTo + '"', cb);
  } else if (this._box.permFlags.indexOf('deleted') === -1) {
    throw new Error('Cannot move message: '
                    + 'server does not allow deletion of messages');
  } else {
    var deletedUIDs, task = 0, self = this;
    this._copy(which, uids, boxTo, function ccb(err, info) {
      if (err)
        return cb(err, info);

      if (task === 0 && which && self.serverSupports('UIDPLUS')) {
        // UIDPLUS gives us a 'UID EXPUNGE n' command to expunge a subset of
        // messages with the \Deleted flag set. This allows us to skip some
        // actions.
        task = 2;
      }
      // Make sure we don't expunge any messages marked as Deleted except the
      // one we are moving
      if (task === 0) {
        self.search(['DELETED'], function(e, result) {
          ++task;
          deletedUIDs = result;
          ccb(e, info);
        });
      } else if (task === 1) {
        if (deletedUIDs.length) {
          self.delFlags(deletedUIDs, 'Deleted', function(e) {
            ++task;
            ccb(e, info);
          });
        } else {
          ++task;
          ccb(err, info);
        }
      } else if (task === 2) {
        function cbMarkDel(e) {
          ++task;
          ccb(e, info);
        }
        if (which)
          self.addFlags(uids, 'Deleted', cbMarkDel);
        else
          self.seq.addFlags(uids, 'Deleted', cbMarkDel);
      } else if (task === 3) {
        if (which && self.serverSupports('UIDPLUS'))
          self.removeDeleted(uids, cb);
        else {
          self.removeDeleted(function(e) {
            ++task;
            ccb(e, info);
          });
        }
      } else if (task === 4) {
        if (deletedUIDs.length) {
          self.addFlags(deletedUIDs, 'Deleted', function(e) {
            cb(e, info);
          });
        } else
          cb(err, info);
      }
    });
  }
};

Connection.prototype.fetch = function(uids, options) {
  this._fetch('UID ', uids, options);
};

Connection.prototype._fetch = function(which, uids, options) {
  if (uids === undefined
      || uids === null
      || (Array.isArray(uids) && uids.length === 0))
    throw new Error('Nothing to fetch');

  if (!Array.isArray(uids))
    uids = [uids];
  validateUIDList(uids);
  uids = uids.join(',');

  var cmd = which + 'FETCH ' + uids + ' (', fetching = [];

  // always fetch GMail-specific bits of information when on GMail
  if (this.serverSupports('X-GM-EXT-1')) {
    fetching.push('X-GM-THRID');
    fetching.push('X-GM-MSGID');
    fetching.push('X-GM-LABELS');
  }

  fetching.push('UID');
  fetching.push('FLAGS');
  fetching.push('INTERNALDATE');

  if (options) {
    if (options.struct)
      fetching.push('BODYSTRUCTURE');
    if (options.size)
      fetching.push('RFC822.SIZE');
    cmd += fetching.join(' ');
    if (options.bodies !== undefined) {
      var bodies = options.bodies,
          prefix = (options.markSeen ? '' : '.PEEK');
      if (!Array.isArray(bodies))
        bodies = [bodies];
      for (var i = 0, len = bodies.length; i < len; ++i) {
        fetching.push('BODY[' + bodies[i] + ']');
        cmd += ' BODY' + prefix + '[' + bodies[i] + ']';
      }
    }
  } else
    cmd += fetching.join(' ');

  cmd += ')';

  this._enqueue(cmd);
  var req = this._queue[this._queue.length - 1];
  req.fetchCache = {};
  req.fetching = fetching;
  return (req.bodyEmitter = new EventEmitter());
};

// Namespace for seqno-based commands
Connection.prototype.__defineGetter__('seq', function() {
  var self = this;
  return {
    move: function(seqnos, boxTo, cb) {
      self._move('', seqnos, boxTo, cb);
    },
    copy: function(seqnos, boxTo, cb) {
      self._copy('', seqnos, boxTo, cb);
    },
    delKeywords: function(seqnos, flags, cb) {
      self._store('', seqnos, flags, false, cb);
    },
    addKeywords: function(seqnos, flags, cb) {
      self._addKeywords('', seqnos, flags, cb);
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

Connection.prototype._resUntagged = function(info) {
  var type = info.type;

  if (type === 'bye')
    this._sock.end();
  else if (type === 'namespace')
    this.namespaces = info.text;
  else if (type === 'capability')
    this._caps = info.text.map(function(v) { return v.toUpperCase(); });
  else if (type === 'preauth')
    this.state = 'authenticated';
  else if (type === 'search' || type === 'sort')
    this._curReq.cbargs.push(info.text);
  else if (type === 'recent') {
    if (!this._box && RE_OPENBOX.test(this._curReq.type))
      this._createCurrentBox();
    this._box.messages.new = info.num;
  }
  else if (type === 'flags') {
    if (!this._box && RE_OPENBOX.test(this._curReq.type))
      this._createCurrentBox();
    this._box.flags = info.text;
  } else if (type === 'bad' || type === 'no') {
    if (this.state === 'connected' && !this._curReq) {
      clearTimeout(this._tmrConn);
      var err = new Error('Received negative welcome: ' + info.text);
      err.level = 'protocol';
      this.emit('error', err);
      this._sock.end();
    }
  } else if (type === 'exists') {
    if (!this._box && RE_OPENBOX.test(this._curReq.type))
      this._createCurrentBox();
    var prev = this._box.messages.total,
        now = info.num;
    this._box.messages.total = now;
    if (now > prev && this.state === 'authenticated') {
      this._box.messages.new = now - prev;
      this.emit('mail', this._box.messages.total);
    }
  } else if (type === 'expunge') {
    if (this._box.messages.total > 0)
      --this._box.messages.total;
    if (!this._curReq)
      this.emit('deleted', info.num);
  } else if (type === 'ok') {
    if (this.state === 'connected' && !this._curReq)
      this._login();
    else if (typeof info.textCode === 'string'
             && info.textCode.toUpperCase() === 'ALERT')
      this.emit('alert', info.text);
    else if (this._curReq
             && typeof info.textCode === 'object'
             && (RE_OPENBOX.test(this._curReq.type))) {
      // we're opening a mailbox

      if (!this._box)
        this._createCurrentBox();

      var key = info.textCode.key.toUpperCase();

      if (key === 'UIDVALIDITY')
        this._box.uidvalidity = info.textCode.val;
      else if (key === 'UIDNEXT')
        this._box.uidnext = info.textCode.val;
      else if (key === 'PERMANENTFLAGS') {
        var idx, permFlags, keywords;
        this._box.permFlags = permFlags = info.textCode.val;
        if ((idx = this._box.permFlags.indexOf('\\*')) > -1) {
          this._box.newKeywords = true;
          permFlags.splice(idx, 1);
        }
        this._box.keywords = keywords = permFlags.filter(function(f) {
                                          return (f[0] !== '\\');
                                        });
        for (var i = 0, len = keywords.length; i < len; ++i)
          permFlags.splice(permFlags.indexOf(keywords[i]), 1);
        this._box.permFlags = permFlags.map(function(f) {
                                return f.substr(1).toLowerCase();
                              });
      }
    }
  } else if (type === 'list') {
    if (this.delimiter === undefined)
      this.delimiter = info.text.delimiter;
    else {
      if (this._curReq.cbargs.length === 0)
        this._curReq.cbargs.push({});

      var box = {
            attribs: info.text.flags.map(function(attr) {
                       return attr.substr(1);
                     }).filter(function(attr) {
                      return (attr.toUpperCase() !== 'HASNOCHILDREN');
                     }),
            delimiter: info.text.delimiter,
            children: null,
            parent: null
          },
          name = info.text.name,
          curChildren = this._curReq.cbargs[0];

      if (box.delimiter) {
        var path = name.split(box.delimiter),
            parent = null;
        name = path.pop();
        for (var i = 0, len = path.length; i < len; ++i) {
          if (!curChildren[path[i]])
            curChildren[path[i]] = {};
          if (!curChildren[path[i]].children)
            curChildren[path[i]].children = {};
          parent = curChildren[path[i]];
          curChildren = curChildren[path[i]].children;
        }
        box.parent = parent;
      }
      if (curChildren[name])
        box.children = curChildren[name].children;
      curChildren[name] = box;
    }
  } else if (type === 'status') {
    var box = {
      name: info.text.name,
      uidvalidity: 0,
      messages: {
        total: 0,
        new: 0,
        unseen: 0
      }
    }, attrs = info.text.attrs;

    if (attrs) {
      if (attrs.recent !== undefined)
        box.messages.new = attrs.recent;
      if (attrs.unseen !== undefined)
        box.messages.unseen = attrs.unseen;
      if (attrs.messages !== undefined)
        box.messages.total = attrs.messages;
      if (attrs.uidvalidity !== undefined)
        box.uidvalidity = attrs.uidvalidity;
    }
    this._curReq.cbargs.push(box);
  } else if (type === 'fetch') {
    var msg = this._curReq.fetchCache[info.num],
        keys = Object.keys(info.text),
        keyslen = keys.length,
        attrs, toget, msgEmitter, i, j;

    if (msg === undefined) {
      // simple case -- no bodies were streamed
      toget = this._curReq.fetching.slice(0);
      if (toget.length === 0)
        return;

      msgEmitter = new EventEmitter();
      attrs = {};

      this._curReq.bodyEmitter.emit('message', msgEmitter, info.num);
    } else {
      toget = msg.toget;
      msgEmitter = msg.msgEmitter;
      attrs = msg.attrs;
    }

    i = toget.length;
    if (i === 0) {
      if (!msg.ended) {
        msg.ended = true;
        msgEmitter.emit('end');
      }
      return;
    }

    if (keyslen > 0) {
      while (--i >= 0) {
        j = keyslen;
        while (--j >= 0) {
          if (keys[j].toUpperCase() === toget[i]) {
            if (!RE_BODYPART.test(toget[i]))
              attrs[FETCH_ATTR_MAP[toget[i]]] = info.text[keys[j]];
            toget.splice(i, 1);
            break;
          }
        }
      }
    }

    if (toget.length === 0) {
      msgEmitter.emit('attributes', attrs);
      msgEmitter.emit('end');
    } else if (msg === undefined) {
      this._curReq.fetchCache[info.num] = {
        msgEmitter: msgEmitter,
        toget: toget,
        attrs: attrs,
        ended: false
      };
    }
  }
};

Connection.prototype._resTagged = function(info) {
  var req = this._curReq, err;

  this._curReq = undefined;

  if (info.type === 'no' || info.type === 'bad') {
    var errtext;
    if (/^AUTHENTICATE XOAUTH/.test(req.fullcmd) && req.oauthError)
      errtext = req.oauthError;
    else
      errtext = info.text;
    var err = new Error(errtext);
    err.textCode = info.textCode;
    err.source = 'protocol';
  } else if (this._box) {
    if (req.type === 'EXAMINE' || req.type === 'SELECT')
      this._box.readOnly = (info.textCode.toUpperCase() === 'READ-ONLY');

    // According to RFC 3501, UID commands do not give errors for
    // non-existant user-supplied UIDs, so give the callback empty results
    // if we unexpectedly received no untagged responses.
    if (RE_UIDCMD_HASRESULTS.test(req.fullcmd) && req.cbargs.length === 0)
      req.cbargs.push([]);
  }

  if (req.bodyEmitter) {
    if (err)
      req.bodyEmitter.emit('error', err);
    req.bodyEmitter.emit('end');
  } else {
    req.cbargs.unshift(err);
    req.cb && req.cb.apply(this, req.cbargs);
  }

  if (this._queue.length === 0
      && this._config.keepalive
      && this.state === 'authenticated') {
    this._idle.enabled = true;
    this._doKeepaliveTimer(true);
  }

  this._processQueue();
};

Connection.prototype._createCurrentBox = function() {
  this._box = {
    name: '',
    flags: [],
    readOnly: false,
    uidvalidity: 0,
    uidnext: 0,
    permFlags: [],
    keywords: [],
    newKeywords: false,
    messages: {
      total: 0,
      new: 0
    }
  };
};

Connection.prototype._doKeepaliveTimer = function(immediate) {
  var self = this,
      timerfn = function() {
        if (self._idle.enabled) {
          // unlike NOOP, IDLE is only a valid command after authenticating
          if (!self.serverSupports('IDLE') || self.state !== 'authenticated')
            self._enqueue('NOOP', true);
          else {
            if (self._idle.started === undefined) {
              self._idle.started = 0;
              self._enqueue('IDLE', true);
            } else if (self._idle.started > 0) {
              var timeDiff = Date.now() - self._idle.started;
              if (timeDiff >= MAX_IDLE_WAIT) {
                self._idle.enabled = false;
                self.debug && self.debug('=> DONE');
                self._sock.write('DONE' + CRLF);
                return;
              }
            }
            self._doKeepaliveTimer();
          }
        }
      };

  if (immediate)
    timerfn();
  else
    this._tmrKeepalive = setTimeout(timerfn, KEEPALIVE_INTERVAL);
};

Connection.prototype._login = function() {
  var self = this, checkedNS = false;

  var reentry = function(err) {
    if (err) {
      self.emit('error', err);
      return self._sock.destroy();
    }

    // 2. Get the list of available namespaces (RFC2342)
    if (!checkedNS && self.serverSupports('NAMESPACE')) {
      checkedNS = true;
      return self._enqueue('NAMESPACE', reentry);
    }

    // 3. Get the top-level mailbox hierarchy delimiter used by the server
    self._enqueue('LIST "" ""', function() {
      self.state = 'authenticated';
      self.emit('ready');
    });
  };

  // 1. Get the supported capabilities
  self._enqueue('CAPABILITY', function() {
    // No need to attempt the login sequence if we're on a PREAUTH connection.
    if (self.state === 'connected') {
      var err,
          checkCaps = function(error) {
            if (error) {
              error.source = 'authentication';
              return reentry(error);
            }

            if (self._caps === undefined) {
              // Fetch server capabilities if they were not automatically
              // provided after authentication
              return self._enqueue('CAPABILITY', reentry);
            } else
              reentry();
          };

      if (self.serverSupports('LOGINDISABLED')) {
        err = new Error('Logging in is disabled on this server');
        err.source = 'authentication';
        return reentry(err);
      }

      if (self.serverSupports('AUTH=XOAUTH') && self._config.xoauth) {
        self._caps = undefined;
        self._enqueue('AUTHENTICATE XOAUTH ' + escape(self._config.xoauth),
                      checkCaps);
      } else if (self.serverSupports('AUTH=XOAUTH2') && self._config.xoauth2) {
        self._caps = undefined;
        self._enqueue('AUTHENTICATE XOAUTH2 ' + escape(self._config.xoauth2),
                      checkCaps);
      } else if (self._config.user && self._config.password) {
        self._caps = undefined;
        self._enqueue('LOGIN "' + escape(self._config.user) + '" "'
                      + escape(self._config.password) + '"', checkCaps);
      } else {
        err = new Error('No supported authentication method(s) available. '
                        + 'Unable to login.');
        err.source = 'authentication';
        return reentry(err);
      }
    } else
      reentry();
  });
};

Connection.prototype._processQueue = function() {
  if (this._curReq || !this._queue.length || !this._sock.writable)
    return;

  this._curReq = this._queue.shift();

  if (this._tagcount === MAX_INT)
    this._tagcount = 0;

  var prefix;

  if (this._curReq.type === 'IDLE' || this._curReq.type === 'NOOP')
    prefix = this._curReq.type;
  else
    prefix = 'A' + (this._tagcount++);

  var out = prefix + ' ' + this._curReq.fullcmd;
  this.debug && this.debug('=> ' + inspect(out));
  this._sock.write(out + CRLF);
};

Connection.prototype._enqueue = function(fullcmd, promote, cb) {
  if (typeof promote === 'function') {
    cb = promote;
    promote = false;
  }

  var info = {
    type: fullcmd.match(RE_CMD)[1],
    fullcmd: fullcmd,
    cb: cb,
    cbargs: []
  }, self = this;

  if (promote)
    this._queue.unshift(info);
  else
    this._queue.push(info);

  if (!this._curReq) {
    // defer until next tick for requests like APPEND where access to the
    // request object is needed immediately after enqueueing
    process.nextTick(function() { self._processQueue(); });
  } else if (this._curReq.type === 'IDLE') {
    this._idle.enabled = false;
    this.debug && this.debug('=> DONE');
    this._sock.write('DONE' + CRLF);
  }
};

module.exports = Connection;

// utilities -------------------------------------------------------------------

function escape(str) {
  return str.replace(RE_BACKSLASH, '\\\\').replace(RE_DBLQUOTE, '\\"');
}
function validateUIDList(uids) {
  for (var i = 0, len = uids.length, intval; i < len; ++i) {
    if (typeof uids[i] === 'string') {
      if (uids[i] === '*' || uids[i] === '*:*') {
        if (len > 1)
          uids = ['*'];
        break;
      } else if (RE_NUM_RANGE.test(uids[i]))
        continue;
    }
    intval = parseInt(''+uids[i], 10);
    if (isNaN(intval)) {
      throw new Error('Message ID/number must be an integer, "*", or a range: '
                      + uids[i]);
    } else if (typeof uids[i] !== 'number')
      uids[i] = intval;
  }
}
function buildSearchQuery(options, extensions, isOrChild) {
  var searchargs = '';
  for (var i = 0, len = options.length; i < len; ++i) {
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
      searchargs += buildSearchQuery(args[0], extensions, true);
      searchargs += ') (';
      searchargs += buildSearchQuery(args[1], extensions, true);
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
          searchargs += modifier + criteria + ' "' + escape(''+args[0])
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
          var num = parseInt(args[0], 10);
          if (isNaN(num))
            throw new Error('Search option argument must be a number');
          searchargs += modifier + criteria + ' ' + args[0];
        break;
        case 'HEADER':
          if (!args || args.length !== 2)
            throw new Error('Incorrect number of arguments for search option: '
                            + criteria);
          searchargs += modifier + criteria + ' "' + escape(''+args[0])
                     + '" "' + escape(''+args[1]) + '"';
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
            if (!(RE_INTEGER.test(args[0])))
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
          searchargs += modifier + criteria + ' "' + escape(''+args[0])
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
            validateUIDList(seqnos);
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
}
