var parseExpr = require('../lib/Parser').parseExpr;

var assert = require('assert'),
    inspect = require('util').inspect;

[

  { source: '(\HasNoChildren) "." SimpleName',
    expected: [ [ 'HasNoChildren' ], '.', "SimpleName" ],
    what: 'Simple mailbox name'
  },

  { source: '(\HasNoChildren) "." "SimpleNameQuoted"',
    expected: [ [ 'HasNoChildren' ], '.', "SimpleNameQuoted" ],
    what: 'Quoted mailbox name'
  },

  { source: '(\HasNoChildren) "." "Simple Name Quoted With Spaces"',
    expected: [ [ 'HasNoChildren' ], '.', "Simple Name Quoted With Spaces" ],
    what: 'Quoted mailbox name with spaces'
  },

  { source: '(\HasNoChildren) "." [NameWithBrackets].AndChild',
    expected: [ [ 'HasNoChildren' ], '.', [ 'NameWithBrackets' ], '.AndChild' ],
    what: 'Mailbox name containings brackets'
  },

  { source: '(\HasNoChildren) "." "[Name With Quotes Spaces Brackets.AndChild]"',
    expected: [ [ 'HasNoChildren' ], '.', '[Name With Quotes Spaces Brackets.AndChild]' ],
    what: 'Mailbox name containings quotes, spaces and brackets'
  },



].forEach(function(v) {
  var result;

  try {
    result = parseExpr(v.source, null, null, false);
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
