var parseHeader = require('../lib/Parser').parseHeader;

var assert = require('assert'),
    inspect = require('util').inspect;

var CRLF = '\r\n';

[
  { source: ['To: Foo', CRLF,
             ' Bar Baz', CRLF],
    expected: { to: [ 'Foo Bar Baz' ] },
    what: 'Folded header value (plain -- space)'
  },
  { source: ['To: Foo', CRLF,
             '\tBar\tBaz', CRLF],
    expected: { to: [ 'Foo\tBar\tBaz' ] },
    what: 'Folded header value (plain -- tab)'
  },
  { source: ['Subject: =?iso-8859-1?Q?=A1Hola,_se=F1or!?=', CRLF],
    expected: { subject: [ '¡Hola, señor!' ] },
    what: 'MIME encoded-word in value'
  },
  { source: ['Subject: =?GB2312?Q?=B2=E2=CA=D4=CC=E2=C4=BF=D3=EB=D6=D0=B9=FA=D0=C5_long_subjects_are_not_OK_12?=', CRLF,
             ' =?GB2312?Q?345678901234567890123456789012345678901234567890123456789012?=', CRLF,
             ' =?GB2312?Q?345678901234567890?=', CRLF],
    expected: { subject: [ '测试题目与中国信 long subjects are not OK 12345678901234567890123456789012345678901234567890123456789012345678901234567890' ] },
    what: 'Folded header value (adjacent MIME encoded-words)'
  },
  { source: ['Subject: =?GB2312?Q?=B2=E2=CA=D4=CC=E2=C4=BF=D3=EB=D6=D0=B9=FA=D0=C5_long_subjects_are_not_OK_12?=', CRLF,
             ' 3=?GB2312?Q?45678901234567890123456789012345678901234567890123456789012?=', CRLF,
             ' 3=?GB2312?Q?45678901234567890?=', CRLF],
    expected: { subject: [ '测试题目与中国信 long subjects are not OK 12 345678901234567890123456789012345678901234567890123456789012 345678901234567890' ] },
    what: 'Folded header value (non-adjacent MIME encoded-words)'
  },
  { source: ['Subject: =?GB2312?Q?=B2=E2=CA=D4=CC=E2=C4=BF=D3=EB=D6=D0=B9=FA=D0=C5_long_subjects_are_not_OK_12?=', CRLF,
             ' 3=?GB2312?Q?45678901234567890123456789012345678901234567890123456789012?=', CRLF,
             ' =?GB2312?Q?345678901234567890?=', CRLF],
    expected: { subject: [ '测试题目与中国信 long subjects are not OK 12 345678901234567890123456789012345678901234567890123456789012345678901234567890' ] },
    what: 'Folded header value (one adjacent, one non-adjacent MIME encoded-words)'
  },
  // header with body
  { source: ['Subject: test subject', CRLF,
             'X-Another-Header: test', CRLF,
             CRLF,
             'This is body: Not a header', CRLF],
    expected: { subject: [ 'test subject' ], 'x-another-header': [ 'test' ] },
    what: 'Header with the body'
  },

].forEach(function(v) {
  var result;

  try {
    result = parseHeader(v.source.join(''));
  } catch (e) {
    console.log(makeMsg(v.what, 'JS Exception: ' + e.stack));
    return;
  }

  assert.deepEqual(result,
                   v.expected,
                   makeMsg(v.what,
                           'Result mismatch:'
                           + '\nParsed: ' + inspect(result, false, 10)
                           + '\nExpected: ' + inspect(v.expected, false, 10)
                   )
                  );
});

function makeMsg(what, msg) {
  return '[' + what + ']: ' + msg;
}