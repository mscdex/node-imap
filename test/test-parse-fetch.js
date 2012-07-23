var assert = require('assert');

var parseFetch = require('../lib/imap.parsers').parseFetch;

var tests = {
  simple: [
    ['', {}],

    ['FLAGS (\\Seen) RFC822.SIZE 44827',
     { flags: [ '\\Seen' ], 'rfc822.size': 44827 }],

    ['FLAGS (\\Seen) UID 4827313',
     { flags: [ '\\Seen' ], id: 4827313 }],

    ['FLAGS (\\Seen) INTERNALDATE "17-Jul-1996 02:44:25 -0700"\
      RFC822.SIZE 4286 ENVELOPE ("Wed, 17 Jul 1996 02:23:25 -0700 (PDT)"\
      "IMAP4rev1 WG mtg summary and minutes"\
      (("Terry Gray" NIL "gray" "cac.washington.edu"))\
      (("Terry Gray" NIL "gray" "cac.washington.edu"))\
      (("Terry Gray" NIL "gray" "cac.washington.edu"))\
      ((NIL NIL "imap" "cac.washington.edu"))\
      ((NIL NIL "minutes" "CNRI.Reston.VA.US")\
      ("John Klensin" NIL "KLENSIN" "MIT.EDU")) NIL NIL\
      "<B27397-0100000@cac.washington.edu>")\
       BODY ("TEXT" "PLAIN" ("CHARSET" "US-ASCII") NIL NIL "7BIT" 3028\
       92)',
     { flags: [ '\\Seen' ],
       date: '17-Jul-1996 02:44:25 -0700',
       'rfc822.size': 4286,
       envelope: [
        'Wed, 17 Jul 1996 02:23:25 -0700 (PDT)',
        'IMAP4rev1 WG mtg summary and minutes',
        [ [ 'Terry Gray', null, 'gray', 'cac.washington.edu' ] ],
        [ [ 'Terry Gray', null, 'gray', 'cac.washington.edu' ] ],
        [ [ 'Terry Gray', null, 'gray', 'cac.washington.edu' ] ],
        [ [ null, null, 'imap', 'cac.washington.edu' ] ],
        [ [ null, null, 'minutes', 'CNRI.Reston.VA.US' ],
          [ 'John Klensin', null, 'KLENSIN', 'MIT.EDU' ] ],
        null,
        null,
        '<B27397-0100000@cac.washington.edu>'
       ],
       body: [
        'TEXT',
        'PLAIN',
        [ 'CHARSET', 'US-ASCII' ],
        null,
        null,
        '7BIT',
        3028,
        92
       ]
     }
    ],

    ['BODYSTRUCTURE (("text" "plain" ("charset" "us-ascii") NIL NIL "quoted-printable" 370 19 NIL NIL NIL NIL)("application" "pdf" ("x-mac-hide-extension" "yes" "x-unix-mode" "0644" "name" "filename.pdf") NIL NIL "base64" 2067794 NIL ("inline" ("filename" "filename.pdf")) NIL NIL) "mixed" ("boundary" "Apple-Mail=_801866EE-56A0-4F30-8DB3-2496094971D1") NIL NIL NIL)',
     { structure:
      [ { type: 'mixed',
          params: { boundary: 'Apple-Mail=_801866EE-56A0-4F30-8DB3-2496094971D1' },

          disposition: null,
          language: null,
          location: null
        },
        [ { partID: '1',
            type: 'text',
            subtype: 'plain',
            params: { charset: 'us-ascii' },
            id: null,
            description: null,
            encoding: 'quoted-printable',
            size: 370,
            lines: 19,
            md5: null,
            disposition: null,
            language: null,
            location: null
        } ],
        [ { partID: '2',
             type: 'application',
             subtype: 'pdf',
             params:
              { 'x-mac-hide-extension': 'yes',
                'x-unix-mode': '0644',
                name: 'filename.pdf' },
             id: null,
             description: null,
             encoding: 'base64',
             size: 2067794,
             md5: null,
             disposition: { type: 'inline', params: { filename: 'filename.pdf' } },
             language: null,
             location: null
        } ]
      ]
     }
    ],

    ['BODYSTRUCTURE (("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 266 16 NIL ("INLINE" NIL) NIL)("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "7BIT" 7343 65 NIL ("INLINE" NIL) NIL) "ALTERNATIVE" ("BOUNDARY" "--4c81da7e1fb95-MultiPart-Mime-Boundary") NIL NIL)',
     { structure:
      [ { type: 'alternative',
          params: { boundary: '--4c81da7e1fb95-MultiPart-Mime-Boundary' },
          disposition: null,
          language: null
        },
        [ { partID: '1',
            type: 'text',
            subtype: 'plain',
            params: { charset: 'utf-8' },
            id: null,
            description: null,
            encoding: '7BIT',
            size: 266,
            lines: 16,
            md5: null,
            disposition: { type: 'INLINE', params: null },
            language: null
        } ],
        [ { partID: '2',
            type: 'text',
            subtype: 'html',
            params: { charset: 'utf-8' },
            id: null,
            description: null,
            encoding: '7BIT',
            size: 7343,
            lines: 65,
            md5: null,
            disposition: { type: 'INLINE', params: null },
            language: null
        } ]
      ]
     }
    ],

    ['BODYSTRUCTURE (("TEXT" "PLAIN" ("CHARSET" "ISO-8859-1") NIL NIL "7BIT" 935 46 NIL NIL NIL) ("TEXT" "HTML" ("CHARSET" "ISO-8859-1") NIL NIL "QUOTED-PRINTABLE" 1962 33 NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "000e0cd294e80dc83c0475bf339b") NIL NIL)',
     { structure:
      [ { type: 'alternative',
          params: { boundary: '000e0cd294e80dc83c0475bf339b' },
          disposition: null,
          language: null
        },
        [ { partID: '1',
            type: 'text',
            subtype: 'plain',
            params: { charset: 'ISO-8859-1' },
            id: null,
            description: null,
            encoding: '7BIT',
            size: 935,
            lines: 46,
            md5: null,
            disposition: null,
            language: null
        } ],
        [ { partID: '2',
            type: 'text',
            subtype: 'html',
            params: { charset: 'ISO-8859-1' },
            id: null,
            description: null,
            encoding: 'QUOTED-PRINTABLE',
            size: 1962,
            lines: 33,
            md5: null,
            disposition: null,
            language: null
        } ]
      ]
     }
    ],

    ['BODYSTRUCTURE ((("TEXT" "PLAIN" ("CHARSET" "ISO-8859-1") NIL NIL "7BIT" 935 46 NIL NIL NIL)("TEXT" "HTML" ("CHARSET" "ISO-8859-1") NIL NIL "QUOTED-PRINTABLE" 1962 33 NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "000e0cd294e80dc83c0475bf339b") NIL NIL)("APPLICATION" "OCTET-STREAM" ("NAME" "license") NIL NIL "BASE64" 98 NIL ("ATTACHMENT" ("FILENAME" "license")) NIL) "MIXED" ("BOUNDARY" "000e0cd294e80dc84c0475bf339d") NIL NIL)',
     { structure:
        [ { type: 'mixed',
           params: { boundary: '000e0cd294e80dc84c0475bf339d' },
           disposition: null,
           language: null
          },
          [ { type: 'alternative',
              params: { boundary: '000e0cd294e80dc83c0475bf339b' },
              disposition: null,
              language: null
            },
            [ { partID: '1.1',
                type: 'text',
                subtype: 'plain',
                params: { charset: 'ISO-8859-1' },
                id: null,
                description: null,
                encoding: '7BIT',
                size: 935,
                lines: 46,
                md5: null,
                disposition: null,
                language: null
            } ],
            [ { partID: '1.2',
               type: 'text',
               subtype: 'html',
               params: { charset: 'ISO-8859-1' },
               id: null,
               description: null,
               encoding: 'QUOTED-PRINTABLE',
               size: 1962,
               lines: 33,
               md5: null,
               disposition: null,
               language: null
            } ]
          ],
          [ { partID: '2',
              type: 'application',
              subtype: 'octet-stream',
              params: { name: 'license' },
              id: null,
              description: null,
              encoding: 'BASE64',
              size: 98,
              md5: null,
              disposition: { type: 'ATTACHMENT', params: { filename: 'license' } },
              language: null
          } ]
        ]
     }
    ]
  ]
};

var result;

for (var i=0,len=tests.simple.length; i<len; ++i) {
  result = {};
  parseFetch(tests.simple[i][0], result);
  assert.deepEqual(tests.simple[i][1], result);
}
