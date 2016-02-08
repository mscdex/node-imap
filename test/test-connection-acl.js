var assert = require('assert'),
    net = require('net'),
    Imap = require('../lib/Connection'),
    result;

var CRLF = '\r\n';

var RESPONSES = [
  ['* CAPABILITY IMAP4rev1 UNSELECT IDLE NAMESPACE QUOTA CHILDREN',
   'A0 OK Thats all she wrote!',
   ''
  ].join(CRLF),
  ['* CAPABILITY IMAP4rev1 UNSELECT IDLE NAMESPACE QUOTA CHILDREN UIDPLUS MOVE ACL',
   'A1 OK authenticated (Success)',
   ''
  ].join(CRLF),
  ['* NAMESPACE (("" "/")) NIL NIL',
   'A2 OK Success',
   ''
  ].join(CRLF),
  ['* LIST (\\Noselect) "/" "/"',
   'A3 OK Success',
   ''
  ].join(CRLF),
  [ 'A4 OK Setacl complete.',
   ''
  ].join(CRLF),
  ['* ACL INBOX john lw',
   'A5 OK Getacl completed.',
   ''
  ].join(CRLF),
  ['* BYE LOGOUT Requested',
   'A6 OK good day (Success)',
   ''
  ].join(CRLF)
];

var srv = net.createServer(function(sock) {
  sock.write('* OK asdf\r\n');
  var buf = '', lines;
  sock.on('data', function(data) {
    buf += data.toString('utf8');
    if (buf.indexOf(CRLF) > -1) {
      lines = buf.split(CRLF);
      buf = lines.pop();
      lines.forEach(function() {
        sock.write(RESPONSES.shift());
      });
    }
  });
});
srv.listen(0, '127.0.0.1', function() {
  var port = srv.address().port;
  var imap = new Imap({
    user: 'foo',
    password: 'bar',
    host: '127.0.0.1',
    port: port,
    keepalive: false
  });
  imap.on('ready', function() {
    imap.setAcl('INBOX', 'john', '+lw', function(err) {
      imap.getAcl('INBOX', function(err, acl) {
        result = acl;
        srv.close();
        imap.end();
      });
    });
  });
  imap.connect();
});

process.once('exit', function() {
  assert.deepEqual(result, {
    box: 'INBOX',
    rights: [{name: 'john', perms: 'lw'}]
  });
});
