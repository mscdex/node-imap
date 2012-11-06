var utils = require('./imap.utilities');

exports.convStr = function(str, literals) {
  if (str[0] === '"')
    return str.substring(1, str.length-1);
  else if (str === 'NIL')
    return null;
  else if (/^\d+$/.test(str)) {
    // some IMAP extensions utilize large (64-bit) integers, which JavaScript
    // can't handle natively, so we'll just keep it as a string if it's too big
    var val = parseInt(str, 10);
    return (val.toString() === str ? val : str);
  } else if (literals && literals.lp < literals.length && /^\{\d+\}$/.test(str))
    return literals[literals.lp++];
  else
    return str;
};

exports.parseNamespaces = function(str, literals) {
  var result, vals;
  if (str.length === 3 && str.toUpperCase() === 'NIL')
    vals = null;
  else {
    result = exports.parseExpr(str, literals);
    vals = [];
    for (var i=0,len=result.length; i<len; ++i) {
      var val = {
        prefix: result[i][0],
        delimiter: result[i][1]
      };
      if (result[i].length > 2) {
        // extension data
        val.extensions = [];
        for (var j=2,len2=result[i].length; j<len2; j+=2) {
          val.extensions.push({
            name: result[i][j],
            flags: result[i][j+1]
          });
        }
      }
      vals.push(val);
    }
  }
  return vals;
};

exports.parseFetch = function(str, literals, fetchData) {
  literals.lp = 0;
  var result = exports.parseExpr(str, literals);
  for (var i=0,len=result.length; i<len; i+=2) {
    if (Array.isArray(result[i]))
      result[i] = 'BODY';
    result[i] = result[i].toUpperCase();
    if (result[i] === 'UID')
      fetchData.uid = parseInt(result[i+1], 10);
    else if (result[i] === 'INTERNALDATE')
      fetchData.date = result[i+1];
    else if (result[i] === 'FLAGS')
      fetchData.flags = result[i+1].filter(utils.isNotEmpty);
    else if (result[i] === 'BODYSTRUCTURE')
      fetchData.structure = exports.parseBodyStructure(result[i+1], literals);
    else if (result[i] === 'RFC822.SIZE')
      fetchData.size = parseInt(result[i+1], 10);
    else if (typeof result[i] === 'string') // simple extensions
      fetchData[result[i].toLowerCase()] = result[i+1];
  }
};

exports.parseBodyStructure = function(cur, literals, prefix, partID) {
  var ret = [], i, len;
  if (prefix === undefined) {
    var result = (Array.isArray(cur) ? cur : exports.parseExpr(cur, literals));
    if (result.length)
      ret = exports.parseBodyStructure(result, literals, '', 1);
  } else {
    var part, partLen = cur.length, next;
    if (Array.isArray(cur[0])) { // multipart
      next = -1;
      while (Array.isArray(cur[++next])) {
        ret.push(exports.parseBodyStructure(cur[next], literals, prefix
                                                    + (prefix !== '' ? '.' : '')
                                                    + (partID++).toString(), 1));
      }
      part = { type: cur[next++].toLowerCase() };
      if (partLen > next) {
        if (Array.isArray(cur[next])) {
          part.params = {};
          for (i=0,len=cur[next].length; i<len; i+=2)
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
        };
      } else {
        // type information for malformed multipart body
        part = { type: cur[0].toLowerCase(), params: null };
        cur.splice(1, 0, null);
        ++partLen;
        next = 2;
      }
      if (Array.isArray(cur[2])) {
        part.params = {};
        for (i=0,len=cur[2].length; i<len; i+=2)
          part.params[cur[2][i].toLowerCase()] = cur[2][i+1];
        if (cur[1] === null)
          ++next;
      }
      if (part.type === 'message' && part.subtype === 'rfc822') {
        // envelope
        if (partLen > next && Array.isArray(cur[next])) {
          part.envelope = {};
          for (i=0,len=cur[next].length; i<len; ++i) {
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
        if (partLen > next && Array.isArray(cur[next]))
          part.body = exports.parseBodyStructure(cur[next], literals, prefix, 1);
        else
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
    exports.parseStructExtra(part, partLen, cur, next);
    ret.unshift(part);
  }
  return ret;
};

exports.parseStructExtra = function(part, partLen, cur, next) {
  if (partLen > next) {
    // disposition
    // null or a special k/v list with these kinds of values:
    // e.g.: ['Foo', null]
    //       ['Foo', ['Bar', 'Baz']]
    //       ['Foo', ['Bar', 'Baz', 'Bam', 'Pow']]
    var disposition = { type: null, params: null };
    if (Array.isArray(cur[next])) {
      disposition.type = cur[next][0];
      if (Array.isArray(cur[next][1])) {
        disposition.params = {};
        for (var i=0,len=cur[next][1].length; i<len; i+=2)
          disposition.params[cur[next][1][i].toLowerCase()] = cur[next][1][i+1];
      }
    } else if (cur[next] !== null)
      disposition.type = cur[next];

    if (disposition.type === null)
      part.disposition = null;
    else
      part.disposition = disposition;

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
};

exports.parseExpr = function(o, literals, result, start) {
  start = start || 0;
  var inQuote = false, lastPos = start - 1, isTop = false;
  if (!result)
    result = [];
  if (typeof o === 'string') {
    o = { str: o };
    isTop = true;
  }
  for (var i=start,len=o.str.length; i<len; ++i) {
    if (!inQuote) {
      if (o.str[i] === '"')
        inQuote = true;
      else if (o.str[i] === ' ' || o.str[i] === ')' || o.str[i] === ']') {
        if (i - (lastPos+1) > 0)
          result.push(exports.convStr(o.str.substring(lastPos+1, i), literals));
        if ((o.str[i] === ')' || o.str[i] === ']') && !isTop)
          return i;
        lastPos = i;
      } else if ((o.str[i] === '(' || o.str[i] === '[')
                 /*&& (i === 0 || !isAlpha(o.str.charCodeAt(i-1)))*/) {
        var innerResult = [];
        i = exports.parseExpr(o, literals, innerResult, i+1);
        lastPos = i;
        result.push(innerResult);
      }
    } else if (o.str[i] === '"' &&
               (o.str[i-1] &&
                (o.str[i-1] !== '\\' || (o.str[i-2] && o.str[i-2] === '\\'))))
      inQuote = false;
    if (i+1 === len && len - (lastPos+1) > 0)
      result.push(exports.convStr(o.str.substring(lastPos+1), literals));
  }
  return (isTop ? result : start);
};
