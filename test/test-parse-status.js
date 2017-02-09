var parseStatus = require('../lib/Parser').parseStatus;

var assert = require('assert'),
    inspect = require('util').inspect;

[
  { source: 'Archive (MESSAGES 0 RECENT 0 UIDNEXT 1 UIDVALIDITY 1486578855 UNSEEN 0 HIGHESTMODSEQ 324239655611538)',
    expected: {
      name: "Archive",
      attrs: {
        recent: 0,
        unseen: 0,
        messages: 0,
        uidnext: 1,
        uidvalidity: 1486578855,
        highestmodseq: 324239655611538,
      }
    },
    what: 'Status response text, name has no brackets and no quotes'
  },
  { source: '"Archive" (MESSAGES 0 RECENT 0 UIDNEXT 1 UIDVALIDITY 1486578855 UNSEEN 0 HIGHESTMODSEQ 324239655611538)',
    expected: {
      name: "Archive",
      attrs: {
        recent: 0,
        unseen: 0,
        messages: 0,
        uidnext: 1,
        uidvalidity: 1486578855,
        highestmodseq: 324239655611538,
      }
    },
    what: 'Status response text, name has no brackets and has quotes'
  },
  { source: '"[Airmail]" (MESSAGES 0 RECENT 0 UIDNEXT 1 UIDVALIDITY 1486578855 UNSEEN 0 HIGHESTMODSEQ 324239655611538)',
    expected: {
      name: "[Airmail]",
      attrs: {
        recent: 0,
        unseen: 0,
        messages: 0,
        uidnext: 1,
        uidvalidity: 1486578855,
        highestmodseq: 324239655611538,
      }
    },
    what: 'Status response text, name has brackets and has quotes'
  },
  { source: '[Airmail] (MESSAGES 0 RECENT 0 UIDNEXT 1 UIDVALIDITY 1486578855 UNSEEN 0 HIGHESTMODSEQ 324239655611538)',
    expected: {
      name: "[Airmail]",
      attrs: {
        recent: 0,
        unseen: 0,
        messages: 0,
        uidnext: 1,
        uidvalidity: 1486578855,
        highestmodseq: 324239655611538,
      }
    },
    what: 'Status response text, name has brackets and no quotes'
  },
  { source: '[Airmail]/To Do (MESSAGES 0 RECENT 0 UIDNEXT 1 UIDVALIDITY 1486578855 UNSEEN 0 HIGHESTMODSEQ 324239655611538)',
    expected: {
      name: "[Airmail]/To Do",
      attrs: {
        recent: 0,
        unseen: 0,
        messages: 0,
        uidnext: 1,
        uidvalidity: 1486578855,
        highestmodseq: 324239655611538,
      }
    },
    what: 'Status response text, name has brackets and no quotes'
  },
  { source: '"[Airmail]/To Do" (MESSAGES 0 RECENT 0 UIDNEXT 1 UIDVALIDITY 1486578855 UNSEEN 0 HIGHESTMODSEQ 324239655611538)',
    expected: {
      name: "[Airmail]/To Do",
      attrs: {
        recent: 0,
        unseen: 0,
        messages: 0,
        uidnext: 1,
        uidvalidity: 1486578855,
        highestmodseq: 324239655611538,
      }
    },
    what: 'Status response text, name has brackets and has quotes'
  },
].forEach(function(v) {
  var result;

  try {
    result = parseStatus(v.source);
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


