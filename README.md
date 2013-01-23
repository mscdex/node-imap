Description
===========

node-imap is an IMAP client module for [node.js](http://nodejs.org/).

This module does not perform any magic such as auto-decoding of messages/attachments or parsing of email addresses (node-imap leaves all mail header values as-is).
If you are in need of this kind of extra functionality, check out andris9's [mimelib](https://github.com/andris9/mimelib) module. Also check out his [mailparser](http://github.com/andris9/mailparser) module, which comes in handy after you fetch() a raw email message with this module and wish to parse it manually.


Requirements
============

* [node.js](http://nodejs.org/) -- v0.6.0 or newer
* An IMAP server -- tested with gmail


Installation
============

    npm install imap

Example
=======

* Fetch the 'date', 'from', 'to', 'subject' message headers and the message structure of all unread messages in the Inbox since May 20, 2010:

```javascript
var Imap = require('imap'),
    inspect = require('util').inspect;
    
var imap = new Imap({
      user: 'mygmailname@gmail.com',
      password: 'mygmailpassword',
      host: 'imap.gmail.com',
      port: 993,
      secure: true
    });

function show(obj) {
  return inspect(obj, false, Infinity);
}

function die(err) {
  console.log('Uh oh: ' + err);
  process.exit(1);
}

function openInbox(cb) {
  imap.connect(function(err) {
    if (err) die(err);
    imap.openBox('INBOX', true, cb);
  });
}

openInbox(function(err, mailbox) {
  if (err) die(err);
  imap.search([ 'UNSEEN', ['SINCE', 'May 20, 2010'] ], function(err, results) {
    if (err) die(err);
    imap.fetch(results,
      { headers: ['from', 'to', 'subject', 'date'],
        cb: function(fetch) {
          fetch.on('message', function(msg) {
            console.log('Saw message no. ' + msg.seqno);
            msg.on('headers', function(hdrs) {
              console.log('Headers for no. ' + msg.seqno + ': ' + show(hdrs));
            });
            msg.on('end', function() {
              console.log('Finished message no. ' + msg.seqno);
            });
          });
        }
      }, function(err) {
        if (err) throw err;
        console.log('Done fetching all messages!');
        imap.logout();
      }
    );
  });
});
```

* Retrieve the 'from' header and buffer the entire body of the newest message:

```javascript
// using the functions and variables already defined in the first example ...

openInbox(function(err, mailbox) {
  if (err) die(err);
  imap.seq.fetch(mailbox.messages.total + ':*', { struct: false },
    { headers: 'from',
      body: true,
      cb: function(fetch) {
        fetch.on('message', function(msg) {
          console.log('Saw message no. ' + msg.seqno);
          var body = '';
          msg.on('headers', function(hdrs) {
            console.log('Headers for no. ' + msg.seqno + ': ' + show(hdrs));
          });
          msg.on('data', function(chunk) {
            body += chunk.toString('utf8');
          });
          msg.on('end', function() {
            console.log('Finished message no. ' + msg.seqno);
            console.log('UID: ' + msg.uid);
            console.log('Flags: ' + msg.flags);
            console.log('Date: ' + msg.date);
            console.log('Body: ' + show(body));
          });
        });
      }
    }, function(err) {
      if (err) throw err;
      console.log('Done fetching all messages!');
      imap.logout();
    }
  );
});
```

* Save raw unread emails since May 20, 2010 to files:

```javascript
// using the functions and variables already defined in the first example ...

var fs = require('fs'), fileStream;

openInbox(function(err, mailbox) {
  if (err) die(err);
  imap.search([ 'UNSEEN', ['SINCE', 'May 20, 2010'] ], function(err, results) {
    if (err) die(err);
    imap.fetch(results,
      { headers: { parse: false },
        body: true,
        cb: function(fetch) {
          fetch.on('message', function(msg) {
            console.log('Got a message with sequence number ' + msg.seqno);
            fileStream = fs.createWriteStream('msg-' + msg.seqno + '-body.txt');
            msg.on('data', function(chunk) {
              fileStream.write(chunk);
            });
            msg.on('end', function() {
              fileStream.end();
              console.log('Finished message no. ' + msg.seqno);
            });
          });
        }
      }, function(err) {
      }
    );
  });
});
```


API
===

node-imap exposes one object: **ImapConnection**.


#### Data types

* _Box_ is an object representing the currently open mailbox, and has the following properties:
    * **name** - < _string_ > - The name of this mailbox.
    * **readOnly** - < _boolean_ > - True if this mailbox was opened in read-only mode.
    * **uidvalidity** - < _integer_ > - A 32-bit number that can be used to determine if UIDs in this mailbox have changed since the last time this mailbox was opened. It is possible for this to change during a session, in which case a 'uidvalidity' event will be emitted on the ImapConnection instance.
    * **uidnext** - < _integer_ > - The uid that will be assigned to the next message that arrives at this mailbox.
    * **permFlags** - < _array_ > - A list of flags that can be permanently added/removed to/from messages in this mailbox.
    * **messages** - < _object_ > Contains various message counts for this mailbox:
        * **total** - < _integer_ > - Total number of messages in this mailbox.
        * **new** - < _integer_ > - Number of messages in this mailbox having the Recent flag (this IMAP session is the first to see these messages).
        * **unseen** - < _integer_ > - **(Only available with status() calls)** Number of messages in this mailbox not having the Seen flag (marked as not having been read).
* _ImapMessage_ is an object representing an email message. It consists of:
    * Properties:
        * **seqno** - < _integer_ > - This message's sequence number. This number changes when messages with smaller sequence numbers are deleted for example (see the ImapConnection's 'deleted' event). This value is **always** available immediately.
        * **uid** - < _integer_ > - A 32-bit ID that uniquely identifies this message within its mailbox.
        * **flags** - < _array_ > - A list of flags currently set on this message.
        * **date** - < _string_ > - The internal server date for the message (always represented in GMT?)
        * **structure** - < _array_ > - The structure of the message, **if the structure was requested with fetch().** See below for an explanation of the format of this property.
        * **size** - < _integer_ > - The RFC822 message size, **if the size was requesting with fetch().**
    * Events:
        * **headers**(< _mixed_ >headers) - Emitted when headers are fetched. This is an _object_ unless 'parse' is set to false when requesting headers, in which case it will be a _Buffer_. Note: if you request a full raw message (all headers and entire body), only 'data' events will be emitted.
        * **data**(< _Buffer_ >chunk) - Emitted for each message body chunk if a message body is being fetched.
        * **end**() - Emitted when the fetch is complete for this message.
* _ImapFetch_ is an object that emits these events:
    * **message**(< _ImapMessage_ >msg) - Emitted for each message resulting from a fetch request

A message structure with multiple parts might look something like the following:

```javascript
  [ { type: 'mixed',
      params: { boundary: '000e0cd294e80dc84c0475bf339d' },
      disposition: null,
      language: null,
      location: null
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
        }
      ],
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
        }
      ]
    ],
    [ { partID: '2',
        type: 'application',
        subtype: 'octet-stream',
        params: { name: 'somefile' },
        id: null,
        description: null,
        encoding: 'BASE64',
        size: 98,
        lines: null,
        md5: null,
        disposition:
         { type: 'attachment',
           params: { filename: 'somefile' }
         },
        language: null,
        location: null
      }
    ]
  ]
```

The above structure describes a message having both an attachment and two forms of the message body (plain text and HTML).
Each message part is identified by a partID which is used when you want to fetch the content of that part (**see fetch()**).

The structure of a message with only one part will simply look something like this:

```javascript
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
    }
  ]
```

Therefore, an easy way to check for a multipart message is to check if the structure length is >1.

Lastly, here are the system flags defined by RFC3501 that may be added/removed:

* Seen - Message has been read
* Answered - Message has been answered
* Flagged - Message is "flagged" for urgent/special attention
* Deleted - Message is "deleted" for removal
* Draft - Message has not completed composition (marked as a draft).

It should be noted however that the IMAP server can limit which flags can be permanently modified for any given message. If in doubt, check the mailbox's **permFlags** _array_ first.
Additional custom flags may be provided by the server. If available, these will also be listed in the mailbox's **permFlags** _array_.


ImapConnection Events
---------------------

* **alert**(< _string_ >alertMsg) - Emitted when the server issues an alert (e.g. "the server is going down for maintenance").

* **mail**(< _integer_ >numNewMsgs) - Emitted when new mail arrives in the currently open mailbox.

* **deleted**(< _integer_ >seqno) - Emitted when a message is deleted from another IMAP connection's session. `seqno` is the sequence number (instead of the unique UID) of the message that was deleted. If you are caching sequence numbers, all sequence numbers higher than this value **MUST** be decremented by 1 in order to stay synchronized with the server and to keep correct continuity.

* **msgupdate**(< _ImapMessage_ >msg) - Emitted when a message's flags have changed, generally from another IMAP connection's session. With that in mind, the only available ImapMessage properties in this case will almost always only be 'seqno' and 'flags' (no 'data' or 'end' events will be emitted on the object).

* **uidvalidity**(< _integer_ >uidvalidity) - Emitted when the UID validity value has changed for the currently open mailbox. Any UIDs previously stored for this mailbox are now invalidated.

* **close**(< _boolean_ >hadError) - Emitted when the connection has completely closed.

* **end**() - Emitted when the connection has ended.

* **error**(< _Error_ >err) - Emitted when an exception/error occurs.


ImapConnection Properties
-------------------------

* **connected** - _boolean_ - Are we connected?

* **authenticated** - _boolean_ - Are we authenticated?

* **capabilities** - _array_ - Contains the IMAP capabilities of the server.

* **delimiter** - _string_ - The (top-level) mailbox hierarchy delimiter. If the server does not support mailbox hierarchies and only a flat list, this value will be `false`.

* **namespaces** - _object_ - Contains information about each namespace type (if supported by the server) with the following properties:

   * **personal** - _array_ - Mailboxes that belong to the logged in user.

   * **other** - _array_ - Mailboxes that belong to other users that the logged in user has access to.

   * **shared** - _array_ - Mailboxes that are accessible by any logged in user.
   
   There should always be at least one entry (although the IMAP spec allows for more, it doesn't seem to be very common) in the personal namespace list, with a blank namespace prefix. Each property's array contains objects of the following format (with example values):

```javascript
  { prefix: '', // A string containing the prefix to use to access mailboxes in this namespace
    delimiter: '/', // A string containing the hierarchy delimiter for this namespace, or boolean false
                    //  for a flat namespace with no hierarchy
    extensions: [ // An array of namespace extensions supported by this namespace, or null if none
                  // are specified
      { name: 'X-FOO-BAR', // A string indicating the extension name
        params: [ 'BAZ' ] // An array of strings containing the parameters for this extension,
                          // or null if none are specified
      }
    ]
  }
```


ImapConnection Functions
------------------------

**Note:** Message UID ranges are not guaranteed to be contiguous.

* **(constructor)**([< _object_ >config]) - _ImapConnection_ - Creates and returns a new instance of _ImapConnection_ using the specified configuration object. Valid config properties are:

    * **user** - < _string_ > - Username for plain-text authentication.

    * **password** - < _string_ > - Password for plain-text authentication.

    * **xoauth** - < _string_ > - OAuth token for [OAuth authentication](https://sites.google.com/site/oauthgoog/Home/oauthimap) for servers that support it (See Andris Reinman's [xoauth.js](https://github.com/andris9/inbox/blob/master/lib/xoauth.js) module to help generate this string).

    * **xoauth2** - < _string_ > - OAuth2 token for [The SASL XOAUTH2 Mechanism](https://developers.google.com/google-apps/gmail/xoauth2_protocol#the_sasl_xoauth2_mechanism) for servers that support it (See Andris Reinman's [xoauth2](https://github.com/andris9/xoauth2) module to help generate this string).

    * **host** - < _string_ > - Hostname or IP address of the IMAP server. **Default:** "localhost"

    * **port** - < _integer_ > - Port number of the IMAP server. **Default:** 143

    * **secure** - < _boolean_ > - Use SSL/TLS? **Default:** false

    * **connTimeout** - < _integer_ > - Number of milliseconds to wait for a connection to be established. **Default:** 10000

    * **debug** - < _function_ > - If set, the function will be called with one argument, a string containing some debug info **Default:** <no debug output>

* **connect**(< _function_ >callback) - _(void)_ - Attempts to connect and log into the IMAP server. `callback` has 1 parameter: < _Error_ >err.

* **logout**(< _function_ >callback) - _(void)_ - Logs out and closes the connection to the server. `callback` has 1 parameter: < _Error_ >err.

* **openBox**(< _string_ >mailboxName[, < _boolean_ >openReadOnly=false], < _function_ >callback) - _(void)_ - Opens a specific mailbox that exists on the server. `mailboxName` should include any necessary prefix/path. `callback` has 2 parameters: < _Error_ >err, < _Box_ >mailbox.

* **closeBox**(< _function_ >callback) - _(void)_ - Closes the currently open mailbox. **Any messages marked as Deleted in the mailbox will be removed if the mailbox was NOT opened in read-only mode.** Additionally, logging out or opening another mailbox without closing the current one first will NOT cause deleted messages to be removed. `callback` has 1 parameter: < _Error_ >err.

* **addBox**(< _string_ >mailboxName, < _function_ >callback) - _(void)_ - Creates a new mailbox on the server. `mailboxName` should include any necessary prefix/path. `callback` has 1 parameter: < _Error_ >err.

* **delBox**(< _string_ >mailboxName, < _function_ >callback) - _(void)_ - Removes a specific mailbox that exists on the server. `mailboxName` should including any necessary prefix/path. `callback` has 1 parameter: < _Error_ >err.

* **renameBox**(< _string_ >oldMailboxName, < _string_ >newMailboxName, < _function_ >callback) - _(void)_ - Renames a specific mailbox that exists on the server. Both `oldMailboxName` and `newMailboxName` should include any necessary prefix/path. `callback` has 2 parameters: < _Error_ >err, < _Box_ >mailbox. **Note:** Renaming the 'INBOX' mailbox will instead cause all messages in 'INBOX' to be moved to the new mailbox.

* **status**(< _string_ >mailboxName, < _function_ >callback) - _(void)_ - Fetches information about a mailbox other than the one currently open. `callback` has 2 parameters: < _Error_ >err, < _Box_ >mailbox. **Note:** There is no guarantee that this will be a fast operation on the server. Also, do *not* call this on the currently open mailbox.

* **getBoxes**([< _string_ >nsPrefix,] < _function_ >callback) - _(void)_ - Obtains the full list of mailboxes. If `nsPrefix` is not specified, the main personal namespace is used. `callback` has 2 parameters: < _Error_ >err, < _object_ >boxes. `boxes` has the following format (with example values):

```javascript
  { INBOX: // mailbox name
     { attribs: [], // mailbox attributes. An attribute of 'NOSELECT' indicates the mailbox cannot
                    // be opened
       delimiter: '/', // hierarchy delimiter for accessing this mailbox's direct children.
       children: null, // an object containing another structure similar in format to this top level,
                      // otherwise null if no children
       parent: null // pointer to parent mailbox, null if at the top level
     },
    Work:
     { attribs: [],
       delimiter: '/',
       children: null,
       parent: null
     },
    '[Gmail]':
     { attribs: [ 'NOSELECT' ],
       delimiter: '/',
       children:
        { 'All Mail':
           { attribs: [],
             delimiter: '/',
             children: null,
             parent: [Circular]
           },
          Drafts:
           { attribs: [],
             delimiter: '/',
             children: null,
             parent: [Circular]
           },
          'Sent Mail':
           { attribs: [],
             delimiter: '/',
             children: null,
             parent: [Circular]
           },
          Spam:
           { attribs: [],
             delimiter: '/',
             children: null,
             parent: [Circular]
           },
          Starred:
           { attribs: [],
             delimiter: '/',
             children: null,
             parent: [Circular]
           },
          Trash:
           { attribs: [],
             delimiter: '/',
             children: null,
             parent: [Circular]
           }
        },
       parent: null
     }
  }
```

* **removeDeleted**(< _function_ >callback) - _(void)_ - Permanently removes (EXPUNGEs) all messages flagged as Deleted in the currently open mailbox. `callback` has 1 parameter: < _Error_ >err. **Note:** At least on Gmail, performing this operation with any currently open mailbox that is not the Spam or Trash mailbox will merely archive any messages marked as Deleted (by moving them to the 'All Mail' mailbox).

* **append**(< _mixed_ >msgData, [< _object_ >options,] < _function_ >callback) - _(void)_ - Appends a message to selected mailbox. `msgData` is a string or Buffer containing an RFC-822 compatible MIME message. Valid `options` properties are:

    * **mailbox** - < _string_ > - The name of the mailbox to append the message to. **Default:** the currently open mailbox

    * **flags** - < _mixed_ > - A single flag (e.g. 'Seen') or an _array_ of flags (e.g. `['Seen', 'Flagged']`) to append to the message. **Default:** (no flags)

    * **date** - < _date_ > - What to use for message arrival date/time. **Default:** (current date/time)
    
  `callback` has 1 parameter: < _Error_ >err.

**All functions below have sequence number-based counterparts that can be accessed by using the 'seq' namespace of the imap connection's instance (e.g. conn.seq.search() returns sequence number(s) instead of UIDs, conn.seq.fetch() fetches by sequence number(s) instead of UIDs, etc):**

* **search**(< _array_ >criteria, < _function_ >callback) - _(void)_ - Searches the currently open mailbox for messages using given criteria. `criteria` is a list describing what you want to find. For criteria types that require arguments, use an _array_ instead of just the string criteria type name (e.g. ['FROM', 'foo@bar.com']). Prefix criteria types with an "!" to negate.

    * The following message flags are valid types that do not have arguments:

        * 'ALL' - All messages.

        * 'ANSWERED' - Messages with the Answered flag set.

        * 'DELETED' - Messages with the Deleted flag set.

        * 'DRAFT' - Messages with the Draft flag set.

        * 'FLAGGED' - Messages with the Flagged flag set.

        * 'NEW' - Messages that have the Recent flag set but not the Seen flag.

        * 'SEEN' - Messages that have the Seen flag set.

        * 'RECENT' - Messages that have the Recent flag set.

        * 'OLD' - Messages that do not have the Recent flag set. This is functionally equivalent to "!RECENT" (as opposed to "!NEW").

        * 'UNANSWERED' - Messages that do not have the Answered flag set.

        * 'UNDELETED' - Messages that do not have the Deleted flag set.

        * 'UNDRAFT' - Messages that do not have the Draft flag set.

        * 'UNFLAGGED' - Messages that do not have the Flagged flag set.

        * 'UNSEEN' - Messages that do not have the Seen flag set.

    * The following are valid types that require string value(s):

        * 'BCC' - Messages that contain the specified string in the BCC field.

        * 'CC' - Messages that contain the specified string in the CC field.

        * 'FROM' - Messages that contain the specified string in the FROM field.

        * 'SUBJECT' - Messages that contain the specified string in the SUBJECT field.

        * 'TO' - Messages that contain the specified string in the TO field.

        * 'BODY' - Messages that contain the specified string in the message body.

        * 'TEXT' - Messages that contain the specified string in the header OR the message body.

        * 'KEYWORD' - Messages with the specified keyword set.

        * 'HEADER' - **Requires two string values, with the first being the header name and the second being the value to search for.** If this second string is empty, all messages that contain the given header name will be returned.

    * The following are valid types that require a string parseable by JavaScript's Date object OR a Date instance:

        * 'BEFORE' - Messages whose internal date (disregarding time and timezone) is earlier than the specified date.

        * 'ON' - Messages whose internal date (disregarding time and timezone) is within the specified date.

        * 'SINCE' - Messages whose internal date (disregarding time and timezone) is within or later than the specified date.

        * 'SENTBEFORE' - Messages whose Date header (disregarding time and timezone) is earlier than the specified date.

        * 'SENTON' - Messages whose Date header (disregarding time and timezone) is within the specified date.

        * 'SENTSINCE' - Messages whose Date header (disregarding time and timezone) is within or later than the specified date.

    * The following are valid types that require one Integer value:

        * 'LARGER' - Messages with a size larger than the specified number of bytes.

        * 'SMALLER' - Messages with a size smaller than the specified number of bytes.

    * The following are valid criterion that require one or more Integer values:

        * 'UID' - Messages with UIDs corresponding to the specified UID set. Ranges are permitted (e.g. '2504:2507' or '\*' or '2504:\*').

    * **Note 1:** For the UID-based search (i.e. "conn.search()"), you can retrieve the UIDs for sequence numbers by just supplying an _array_ of sequence numbers and/or ranges as a criteria (e.g. [ '24:29', 19, '66:*' ]).

    * **Note 2:** By default, all criterion are ANDed together. You can use the special 'OR' on **two** criterion to find messages matching either search criteria (see example below).

  `criteria` examples:

    * Unread messages since April 20, 2010: [ 'UNSEEN', ['SINCE', 'April 20, 2010'] ]

    * Messages that are EITHER unread OR are dated April 20, 2010 or later, you could use: [ ['OR', 'UNSEEN', ['SINCE', 'April 20, 2010'] ] ]

    * All messages that have 'node-imap' in the subject header: [ ['HEADER', 'SUBJECT', 'node-imap'] ]

    * All messages that _do not_ have 'node-imap' in the subject header: [ ['!HEADER', 'SUBJECT', 'node-imap'] ]
    
  `callback` has 2 parameters: < _Error_ >err, < _array_ >UIDs.

* **fetch**(< _mixed_ >source, [< _object_ >options, ] < _mixed_ >request, < _function_ >callback) - _(void)_ - Fetches message(s) in the currently open mailbox. `source` can be a message UID, a message UID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an _array_ of message UIDs and/or message UID ranges.

Valid `options` properties are:

  * **markSeen** - < _boolean_ > - Mark message(s) as read when fetched. **Default:** false

  * **struct** - < _boolean_ > - Fetch the message structure. **Default:** false

  * **size** - < _boolean_ > - Fetch the RFC822 size. **Default:** false

`request` is an _object_ or an _array_ of _object_ with the following valid properties:

  * **id** - < _mixed_ > - _integer_ or _string_ referencing a message part to use when retrieving headers and/or a body. **Default:** (root part/entire message)

  * **headers** - < _mixed_ > - An _array_ of specific headers to retrieve, a _string_ containing a single header to retrieve, _boolean_ true to fetch all headers, or an _object_ of the form (**Default:** (no headers)):

      * **fields** - < _mixed_ > - An _array_ of specific headers to retrieve or _boolean_ true to fetch all headers. **Default:** (all headers)

      * **parse** - < _boolean_ > - Parse headers? **Default:** true

  * **headersNot** - < _mixed_ > - An _array_ of specific headers to exclude, a _string_ containing a single header to exclude, or an _object_ of the form (**Default:** (no headers)):

      * **fields** - < _mixed_ > - An _array_ of specific headers to exclude. **Default:** (all headers)

      * **parse** - < _boolean_ > - Parse headers? **Default:** true

  * **body** - < _boolean_ > - _boolean_ true to fetch the body

  * **cb** - < _function_ > - A callback that is passed an _ImapFetch_ object.

`callback` has 1 parameter: < _Error_ >err. This is executed when all message retrievals are complete.

* **copy**(< _mixed_ >source, < _string_ >mailboxName, < _function_ >callback) - _(void)_ - Copies message(s) in the currently open mailbox to another mailbox. `source` can be a message UID, a message UID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an _array_ of message UIDs and/or message UID ranges. `callback` has 1 parameter: < _Error_ >err.

* **move**(< _mixed_ >source, < _string_ >mailboxName, < _function_ >callback) - _(void)_ - Moves message(s) in the currently open mailbox to another mailbox. `source` can be a message UID, a message UID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an _array_ of message UIDs and/or message UID ranges. `callback` has 1 parameter: < _Error_ >err. **Note:** The message(s) in the destination mailbox will have a new message UID.

* **addFlags**(< _mixed_ >source, < _mixed_ >flags, < _function_ >callback) - _(void)_ - Adds flag(s) to message(s). `source` can be a message UID, a message UID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an _array_ of message UIDs and/or message UID ranges. `flags` is either a single flag or an _array_ of flags. `callback` has 1 parameter: < _Error_ >err.

* **delFlags**(< _mixed_ >source, < _mixed_ >flags, < _function_ >callback) - _(void)_ - Removes flag(s) from message(s). `source` can be a message UID, a message UID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an _array_ of message UIDs and/or message UID ranges. `flags` is either a single flag or an _array_ of flags. `callback` has 1 parameter: < _Error_ >err.

* **addKeywords**(< _mixed_ >source, < _mixed_ >keywords, < _function_ >callback) - _(void)_ - Adds keyword(s) to message(s). `source` can be a message UID, a message UID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an _array_ of message UIDs and/or message UID ranges. `keywords` is either a single keyword or an _array_ of keywords. `callback` has 1 parameter: < _Error_ >err.

* **delKeywords**(< _mixed_ >source, < _mixed_ >keywords, < _function_ >callback) - _(void)_ - Removes keyword(s) from message(s). `source` can be a message UID, a message UID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an _array_ of message UIDs and/or message UID ranges. `keywords` is either a single keyword or an _array_ of keywords. `callback` has 1 parameter: < _Error_ >err.


Extensions Supported
--------------------

* **Gmail**

    * Server capability: X-GM-EXT-1

    * search() criteria extensions

        * X-GM-RAW: string value which allows you to use Gmail's web interface search syntax, such as: "has:attachment in:unread"

        * X-GM-THRID: allows you to search for a specific conversation/thread id which is associated with groups of messages

        * X-GM-MSGID: allows you to search for a specific message given its account-wide unique id

        * X-GM-LABELS: string value which allows you to search for specific messages that have the given label applied

    * fetch() will automatically retrieve the thread id, unique message id, and labels (named 'x-gm-thrid', 'x-gm-msgid', 'x-gm-labels' respectively) and they will be stored on the _ImapMessage_ object itself

    * Additional ImapConnection functions

        * **setLabels**(< _mixed_ >source, < _mixed_ >labels, < _function_ >callback) - _(void)_ - Replaces labels(s) of message(s). `source` can be a message UID, a message UID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an _array_ of message UIDs and/or message UID ranges. `labels` is either a single label or an _array_ of labels. `callback` has 1 parameter: < _Error_ >err.

        * **addLabels**(< _mixed_ >source, < _mixed_ >labels, < _function_ >callback) - _(void)_ - Adds labels(s) to message(s). `source` can be a message UID, a message UID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an _array_ of message UIDs and/or message UID ranges. `labels` is either a single label or an _array_ of labels. `callback` has 1 parameter: < _Error_ >err.

        * **delLabels**(< _mixed_ >source, < _mixed_ >labels, < _function_ >callback) - _(void)_ - Removes labels(s) from message(s). `source` can be a message UID, a message UID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an _array_ of message UIDs and/or message UID ranges. `labels` is either a single label or an _array_ of labels. `callback` has 1 parameter: < _Error_ >err.

* **SORT**

    * Server capability: SORT

    * Additional ImapConnection functions

      * **sort**(< _array_ >sortCriteria, < _array_ >searchCriteria, < _function_ >callback) - _(void)_ - Performs a sorted search(). A seqno-based counterpart also exists for this function. `callback` has 2 parameters: < _Error_ >err, < _array_ >UIDs. Valid `sortCriteria` are (reverse sorting of individual criteria is done by prefixing the criteria with '-'):

        * 'ARRIVAL' - Internal date and time of the message.  This differs from the ON criteria in search(), which uses just the internal date.

        * 'CC' - The mailbox of the **first** "cc" address.

        * 'DATE' - Message sent date and time.

        * 'FROM' - The mailbox of the **first** "from" address.

        * 'SIZE' - Size of the message in octets.

        * 'SUBJECT' - Base subject text.

        * 'TO' - The mailbox of the **first** "to" address.


TODO
----

Several things not yet implemented in no particular order:

* Support STARTTLS
* Support AUTH=CRAM-MD5/AUTH=CRAM_MD5 authentication
* Support additional IMAP commands/extensions:
  * NOTIFY (via NOTIFY extension -- http://tools.ietf.org/html/rfc5465)
  * STATUS addition to LIST (via LIST-STATUS extension -- http://tools.ietf.org/html/rfc5819)
  * GETQUOTA (via QUOTA extension -- http://tools.ietf.org/html/rfc2087)
  * UNSELECT (via UNSELECT extension -- http://tools.ietf.org/html/rfc3691)
  * THREAD (via THREAD=ORDEREDSUBJECT and/or THREAD=REFERENCES extension(s) -- http://tools.ietf.org/html/rfc5256)
  * ID (via ID extension -- http://tools.ietf.org/html/rfc2971) ?
