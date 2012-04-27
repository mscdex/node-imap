var imap = require('../imap'), util = require('util'),
    parseBodyStructure = imap._testFuncs.parseBodyStructure,
    parseExpr = imap._testFuncs.parseExpr;

var DEBUG = false;

function maybeDebugStructure(bodystructureString) {
  var expr = parseExpr(bodystructureString);
  if (DEBUG) {
    console.log("expr:");
    console.log(util.inspect(expr, false, 6));
  }
  var structure = parseBodyStructure(expr[0]);
  if (DEBUG) {
    console.log("structure:");
    console.log(util.inspect(structure, false, 6));
  }
  return structure;
}

exports["Disposition"] = {
  "Multipart Inline PDF (Dovecot, Apple Mail)": function(test) {
    var BODYSTRUCTURE = '(("text" "plain" ("charset" "us-ascii") NIL NIL "quoted-printable" 370 19 NIL NIL NIL NIL)("application" "pdf" ("x-mac-hide-extension" "yes" "x-unix-mode" "0644" "name" "filename.pdf") NIL NIL "base64" 2067794 NIL ("inline" ("filename" "filename.pdf")) NIL NIL) "mixed" ("boundary" "Apple-Mail=_801866EE-56A0-4F30-8DB3-2496094971D1") NIL NIL NIL)';

    var structure = maybeDebugStructure(BODYSTRUCTURE), part;

    part = structure[2][0];
    test.equal(part.partID, 2);
    test.equal(part.disposition.type, 'inline');
    test.equal(part.disposition.params.filename, 'filename.pdf');
    test.done();
  },
};
