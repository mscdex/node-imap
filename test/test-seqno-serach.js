var ImapConnection = require("../lib/imap").ImapConnection,
    imap = new ImapConnection({
      username: "pingkitnet@gmail.com",
      password: "ping5555566666",
      host: "imap.gmail.com",
      port: 993,
      secure: true
    });


imap.connect(function() {
  imap.openBox('INBOX', false, function() {
    //find uid by seqno
    imap.search([["1:5", "8:10"]], function(e, results) {
      console.log(e, results);
      imap.logout();
    });
  })
});

