var parseBoxList = require('../lib/Parser').parseBoxList;

var assert = require('assert'),
    inspect = require('util').inspect;

[
  { source: '(\\Noselect) "/" ""',
    expected: {
      flags: [
        "\\Noselect"
      ],
      delimiter: "/",
      name: ""
    },
    what: 'Simple box info, empty name'
  },
  { source: '(\\HasChildren) "/" "INBOX"',
    expected: {
      flags: [
        "\\HasChildren",
      ],
      delimiter: "/",
      name: "INBOX"
    },
    what: 'Simple box info, name has quotes'
  },
  { source: '(\\HasNoChildren) "/" Archive',
    expected: {
      flags: [
        "\\HasNoChildren"
      ],
      delimiter: "/",
      name: "Archive"
    },
    what: 'Simple box info, name does not have quotes'
  },
  { source: '(\\HasChildren \\Noselect) "/" "[Gmail]/All Mail"',
    expected: {
      flags: [
        "\\HasChildren",
        "\\Noselect"
      ],
      delimiter: "/",
      name: "[Gmail]/All Mail"
    },
    what: 'Simple box info, name has brackets and has quotes'
  },
  { source: '(\\HasChildren \\Noselect) "/" [Airmail]/To Do',
    expected: {
      flags: [
        "\\HasChildren",
        "\\Noselect"
      ],
      delimiter: "/",
      name: "[Airmail]/To Do"
    },
    what: 'Simple box info, name has brackets and does not have quotes'
  },
].forEach(function(v) {
  var result;

  try {
    result = parseBoxList(v.source);
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

