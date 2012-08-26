var inherits = require('util').inherits,
    EventEmitter = require('events').EventEmitter;

var PARSE_HEADER_NAME = 0,
    PARSE_HEADER_VAL = 1,
    PARSE_BODY = 2;

var CR = 13,
    LF = 10,
    COLON = 58,
    SPACE = 32,
    TAB = 9,
    REGEXP_FOLD = /\r\n\s+/g;

var MIMEParser = module.exports = function() {
  this.finish();
};
inherits(MIMEParser, EventEmitter);

MIMEParser.prototype.execute = function(b, start, end) {
  if (this._state == PARSE_BODY) {
    var chunk;
    if ((start === undefined && end === undefined)
        || (start === 0 && end === b.length))
      chunk = b;
    else
      chunk = b.slice(start, end);
    return this.emit('data', chunk);
  }
  start || (start = 0);
  end || (end = b.length);

  var i = start, finished = false;
  while (i < end) {
    if (this._state === PARSE_HEADER_NAME) {
      if (i > start)
        start = i;
      while (i < end) {
        if (b[i] === COLON) {
          this._state = PARSE_HEADER_VAL;
          finished = true;
          break;
        }
        ++i;
      }
      if (this._state === PARSE_HEADER_NAME)
        this._hdrname += b.toString('ascii', start, end);
      else if (finished) {
        this._hdrname += b.toString('ascii', start, (i < end ? i : end));
        finished = false;
        ++i;
      }
    } else if (this._state === PARSE_HEADER_VAL) {
      if (i > start)
        start = i;
      while (i < end) {
        if (b[i] === CR) {
          if (!(this._sawCR && this._sawLF)) {
            this._sawCR = true;
            this._sawLF = false;
          }
        } else if (b[i] === LF && this._sawCR) {
          if (this._sawLF) {
            this._state = PARSE_BODY;
            this._sawCR = false;
            this._sawLF = false;
            finished = true;
            break;
          }
          this._sawLF = true;
        } else {
          if (this._sawCR && this._sawLF) {
            if (b[i] !== SPACE && b[i] !== TAB) {
              this._state = PARSE_HEADER_NAME;
              this._sawCR = false;
              this._sawLF = false;
              finished = true;
              break;
            } else {
              this._needUnfold = true;
              // unfold
              /*this._hdrval += b.toString('ascii', start, (i < end ? i - 2 : end));
              start = i;*/
            }
          }
          this._sawCR = false;
        }
        ++i;
      }
      if (this._state === PARSE_HEADER_VAL)
        this._hdrval += b.toString('ascii', start, (i < end ? i : end));
      else if (finished) {
        this._hdrval += b.toString('ascii', start, (i < end ? i - 2 : end));
        if (this._needUnfold)
          this._hdrval = this._hdrval.replace(REGEXP_FOLD, ' ');
        this.emit('header', this._hdrname, this._hdrval.trim());
        this._hdrname = '';
        this._hdrval = '';
        this._needUnfold = false;
        finished = false;
        if (this._state === PARSE_BODY) {
          if ((i + 1) < end)
            this.emit('data', b.slice(i + 1, end));
          return;
        }
      }
    }
  }
};

MIMEParser.prototype.finish = function() {
  this._state = PARSE_HEADER_NAME;
  this._hdrname = '';
  this._hdrval = '';
  this._sawCR = false;
  this._sawLF = false;
  this._needUnfold = false;
};