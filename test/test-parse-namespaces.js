var assert = require('assert');

var parseNamespaces = require('../lib/imap.parsers').parseNamespaces;

var tests = {
  simple: [
    ['', {}],

    ['(("" "/")) NIL NIL',
     { personal: [ { prefix: '', delim: '/' } ] }],

    ['(("INBOX." ".")) NIL  NIL',
     { personal: [ { prefix: 'INBOX.', delim: '.' } ] }],

    ['NIL NIL (("" "."))',
     { shared: [ { prefix: '', delim: '.' } ] }],

    ['(("" "/")) NIL (("Public Folders/" "/"))',
     { personal: [ { prefix: '', delim: '/' } ],
       shared: [ { prefix: 'Public Folders/', delim: '/' } ] }
    ],

    ['(("" "/")) (("~" "/")) (("#shared/" "/")("#public/" "/")("#ftp/" "/")("#news." "."))',
     { personal: [ { prefix: '', delim: '/' } ],
       other: [ { prefix: '~', delim: '/' } ],
       shared:
        [ { prefix: '#shared/', delim: '/' },
          { prefix: '#public/', delim: '/' },
          { prefix: '#ftp/', delim: '/' },
          { prefix: '#news.', delim: '.' }
        ]
     }
    ],

    ['(("" "/")("#mh/" "/" "X-PARAM" ("FLAG1" "FLAG2"))) NIL NIL',
     { personal:
        [ { prefix: '', delim: '/' },
          { prefix: '#mh/',
            delim: '/',
            extensions: [ { name: 'X-PARAM', flags: [ 'FLAG1', 'FLAG2' ] } ]
          }
        ]
     }
    ]
  ]
};

var result;

for (var i=0,len=tests.simple.length; i<len; ++i) {
  result = {};
  parseNamespaces(tests.simple[i][0], result);
  assert.deepEqual(tests.simple[i][1], result);
}
