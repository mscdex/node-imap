/*jslint node: true, nomen: true */

var assert = require('assert');

var ImapConnection = require('../lib/imap').ImapConnection;

var imap = new ImapConnection({
    xoauthGmail: {
        user: "mike@example.com",
        requestorId: "mike@example.com",
        consumerKey: 'some key',
        consumerSecret: 'some more secret key'
    }
});

assert.notEqual(imap._options.xoauth, "", "xoauth should be set");
assert(imap._options.xoauth.length > 300);

var imap2 = new ImapConnection({
    xoauth: "some string"
})

assert.equal(imap2._options.xoauth, "some string", "xoauth should be untouched");

var imap3 = new ImapConnection({
    user: "mike@example.com"
})

assert.equal(imap3._options.xoauth, undefined, "xoauth should be undefined");
